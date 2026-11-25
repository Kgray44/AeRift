//! Small typed wire boundary for the off-default Windows qualification screen.
use aerift_peers::Device;
use aerift_transfer::{ErrorCode, PeerId, State, Status, TransferError};
use serde::{Deserialize, Serialize};
use std::{future::Future, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;

use crate::{DeviceCard, EndpointId, SecretKey, WanSession};

const CARD_PREFIX: &str = "aerift-card-v1:";

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QualificationAction {
    Snapshot {},
    CreateInvite {
        card: String,
        verified: bool,
    },
    CancelInvite {},
    Redeem {
        issuer_card: String,
        code: String,
        verified: bool,
    },
    PairDecision {
        request: uuid::Uuid,
        allow: bool,
    },
    ChooseAndSend {
        peer: PeerId,
    },
    OfferDecision {
        peer: PeerId,
        offer: uuid::Uuid,
        allow: bool,
    },
    Revoke {
        peer: PeerId,
        confirmed: bool,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    request: uuid::Uuid,
    device: Device,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferView {
    peer: PeerId,
    offer: uuid::Uuid,
    name: String,
    size: u64,
    state: State,
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum QualificationReply {
    Snapshot {
        card: String,
        devices: Vec<Device>,
        pending: Option<PendingView>,
        offers: Vec<OfferView>,
    },
    Invitation {
        code: String,
    },
    Sent {
        status: Status,
    },
    Acknowledged,
}

pub struct QualificationController {
    session: Arc<WanSession>,
    send: Mutex<()>,
    redeem: Mutex<()>,
}

impl QualificationController {
    pub fn new(session: WanSession) -> Self {
        Self {
            session: Arc::new(session),
            send: Mutex::new(()),
            redeem: Mutex::new(()),
        }
    }

    pub async fn stop(&self) -> std::io::Result<()> {
        self.session.stop().await
    }

    /// Only this callback may provide the native selected path. The wire
    /// action is deserialized with unknown fields rejected and has no path.
    pub async fn execute<Pick: Future<Output = Result<Option<PathBuf>, TransferError>>>(
        &self,
        action: QualificationAction,
        picker: impl FnOnce() -> Pick,
    ) -> Result<QualificationReply, TransferError> {
        use QualificationAction as A;
        let session = &self.session;
        match action {
            A::Snapshot {} => Ok(QualificationReply::Snapshot {
                card: session.card().public_text(),
                devices: session.connected_devices(),
                pending: session
                    .subscribe_pairing()
                    .borrow()
                    .as_ref()
                    .map(|pending| PendingView {
                        request: pending.id,
                        device: pending.device.clone(),
                    }),
                offers: session
                    .transfers()
                    .into_iter()
                    .filter(|incoming| {
                        !matches!(incoming.status.state, State::Rejected | State::Cancelled)
                    })
                    .map(|incoming| OfferView {
                        peer: incoming.key.peer,
                        offer: incoming.key.id,
                        name: incoming.offer.name,
                        size: incoming.offer.size_bytes,
                        state: incoming.status.state,
                    })
                    .collect(),
            }),
            A::CreateInvite {
                card,
                verified: true,
            } => Ok(QualificationReply::Invitation {
                code: session.invite(parse_card(&card)?)?,
            }),
            A::CancelInvite {} => {
                session.cancel_invitation();
                Ok(QualificationReply::Acknowledged)
            }
            A::Redeem {
                issuer_card,
                code,
                verified: true,
            } if code.len() <= 8192 => {
                let _one = self.redeem.try_lock().map_err(|_| ErrorCode::Conflict)?;
                session
                    .redeem_verified_card(code.trim(), parse_card(&issuer_card)?)
                    .await?;
                Ok(QualificationReply::Acknowledged)
            }
            A::PairDecision { request, allow } => {
                let pending = session
                    .subscribe_pairing()
                    .borrow()
                    .clone()
                    .filter(|given| given.id == request)
                    .ok_or(ErrorCode::PairingExpired)?;
                session.confirm_pairing(&pending, allow)?;
                Ok(QualificationReply::Acknowledged)
            }
            A::ChooseAndSend { peer } => {
                let _one = self.send.try_lock().map_err(|_| ErrorCode::Conflict)?;
                if !session
                    .connected_devices()
                    .iter()
                    .any(|device| device.id == peer)
                {
                    return Err(ErrorCode::PeerUntrusted.into());
                }
                let path = picker().await?.ok_or(ErrorCode::Cancelled)?;
                let status = session.send_selected_file(peer, path).await?;
                Ok(QualificationReply::Sent { status })
            }
            A::OfferDecision { peer, offer, allow } => {
                let pending = session
                    .transfers()
                    .into_iter()
                    .find(|incoming| {
                        incoming.key.peer == peer
                            && incoming.key.id == offer
                            && incoming.status.state == State::Pending
                    })
                    .ok_or(ErrorCode::InvalidRequest)?;
                session.respond(pending.key, allow)?;
                Ok(QualificationReply::Acknowledged)
            }
            A::Revoke {
                peer,
                confirmed: true,
            } => {
                if !session
                    .connected_devices()
                    .iter()
                    .any(|device| device.id == peer)
                {
                    return Err(ErrorCode::PeerUntrusted.into());
                }
                session.revoke(peer)?;
                Ok(QualificationReply::Acknowledged)
            }
            _ => Err(ErrorCode::InvalidRequest.into()),
        }
    }
}

impl DeviceCard {
    /// Derive only the two public identifiers, without creating an endpoint.
    /// Seed persistence and profile locking stay in the native caller.
    pub fn derive_offline(identity: PeerId, seed: [u8; 32]) -> Result<Self, TransferError> {
        if seed == [0; 32] {
            return Err(ErrorCode::StorageFailed.into());
        }
        Ok(Self {
            identity,
            endpoint: SecretKey::from_bytes(&seed).public(),
        })
    }

    pub fn public_text(self) -> String {
        format!("{CARD_PREFIX}{}:{}", self.identity, self.endpoint)
    }
}

fn parse_card(value: &str) -> Result<DeviceCard, TransferError> {
    let value = value.trim();
    if value.len() != CARD_PREFIX.len() + 129 {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let (identity, endpoint) = value
        .strip_prefix(CARD_PREFIX)
        .and_then(|body| body.split_once(':'))
        .ok_or(ErrorCode::InvalidRequest)?;
    let card = DeviceCard {
        identity: identity.parse()?,
        endpoint: endpoint
            .parse::<EndpointId>()
            .map_err(|_| ErrorCode::InvalidRequest)?,
    };
    if card.public_text() != value {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(card)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_card_uses_the_same_canonical_public_wire_shape() {
        let identity = PeerId::from_tls_leaf(b"synthetic cert");
        let seed = [7; 32];
        let card = DeviceCard::derive_offline(identity, seed).unwrap();
        assert_eq!(card.endpoint, SecretKey::from_bytes(&seed).public());
        let encoded = card.public_text();
        let parsed = parse_card(&encoded).unwrap();
        assert_eq!(parsed.identity, identity);
        assert_eq!(parsed.endpoint, card.endpoint);
        assert_eq!(parsed.public_text(), encoded);
        assert!(!encoded.contains(&"07".repeat(32)));
        assert!(DeviceCard::derive_offline(identity, [0; 32]).is_err());
    }

    #[test]
    fn action_schema_does_not_accept_paths_relays_or_extra_fields() {
        let peer = "0".repeat(64);
        for forbidden in [
            format!(r#"{{"type":"chooseAndSend","peer":"{peer}","path":"C:\\private.txt"}}"#),
            format!(
                r#"{{"type":"chooseAndSend","peer":"{peer}","relay":"https://wrong.invalid"}}"#
            ),
            r#"{"type":"snapshot","address":"192.0.2.1"}"#.into(),
        ] {
            assert!(serde_json::from_str::<QualificationAction>(&forbidden).is_err());
        }
        assert!(
            serde_json::from_str::<QualificationAction>(&format!(
                r#"{{"type":"chooseAndSend","peer":"{peer}"}}"#
            ))
            .is_ok()
        );
    }
}
