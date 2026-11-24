//! Persist and bind authenticated, consent-only offer metadata. No object bytes.
use super::{
    ErrorCode, FriendBook, FriendDecision, PeerId, PersonId, TransferError, Uuid, Variant, Version,
};

use aerift_transfer::{Offer, Status, TransferKey};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_INCOMING: usize = 128;
const MAX_LIFETIME: u64 = 900;

pub(crate) fn unix_seconds() -> Result<u64, TransferError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| ErrorCode::InternalError.into())
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FriendObjectKind {
    File,
    Folder,
    Photo,
    Video,
    Link,
    Clipboard,
    Note,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FriendControlObject {
    kind: FriendObjectKind,
    label: String,
    size_bytes: u64,
    expires_at: u64,
}

impl FriendControlObject {
    pub fn new(
        kind: FriendObjectKind,
        label: String,
        size_bytes: u64,
        expires_at: u64,
    ) -> Result<Self, TransferError> {
        let metadata = Self {
            kind,
            label,
            size_bytes,
            expires_at,
        };
        metadata.validate_shape()?;
        Ok(metadata)
    }
    fn validate_shape(&self) -> Result<(), TransferError> {
        if self.label.is_empty()
            || self.label.len() > 200
            || self.label.trim() != self.label
            || matches!(self.label.as_str(), "." | "..")
            || self.label.chars().any(|ch| {
                ch.is_control()
                    || matches!(
                        ch,
                        '/' | '\\' | '\u{202e}' | '\u{202d}' | '\u{2066}'..='\u{2069}'
                    )
            })
            || self.size_bytes > (1 << 53) - 1
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(())
    }
    fn validate(&self, now: u64) -> Result<(), TransferError> {
        self.validate_shape()?;
        if self.expired(now) || self.expires_at - now > MAX_LIFETIME {
            return Err(ErrorCode::TransferRejected.into());
        }
        Ok(())
    }
    pub(crate) fn expired(&self, now: u64) -> bool {
        now >= self.expires_at
    }
    pub fn kind(&self) -> FriendObjectKind {
        self.kind
    }
    pub fn label(&self) -> &str {
        &self.label
    }
    pub fn size_bytes(&self) -> u64 {
        self.size_bytes
    }
    pub fn expires_at(&self) -> u64 {
        self.expires_at
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::friends) struct Delivery {
    id: Uuid,
    ticket: Uuid,
    digest: [u8; 32],
    sender: PersonId,
    recipient: PersonId,
    recipient_device: PeerId,
    relationship: Uuid,
    metadata: FriendControlObject,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct FriendIncomingOffer {
    notice: Delivery,
    issuer: PeerId,
    decision: FriendDecision,
    #[serde(default)]
    consent_intent: bool,
    #[serde(default)]
    payload_reserved: bool,
}

impl FriendIncomingOffer {
    pub fn id(&self) -> Uuid {
        self.notice.id
    }
    pub fn sender(&self) -> PersonId {
        self.notice.sender
    }
    pub fn issuer(&self) -> PeerId {
        self.issuer
    }
    pub fn decision(&self) -> FriendDecision {
        self.decision
    }
    pub fn object(&self) -> &FriendControlObject {
        &self.notice.metadata
    }
    pub(in crate::friends) fn ticket(&self) -> Uuid {
        self.notice.ticket
    }
    pub(in crate::friends) fn digest(&self) -> [u8; 32] {
        self.notice.digest
    }
}

fn allowed_payload(
    data: &super::Data,
    destination: PeerId,
    key: TransferKey,
    now: u64,
) -> Result<usize, TransferError> {
    let index = data
        .incoming
        .iter()
        .position(|o| {
            o.issuer == key.peer
                && o.id() == key.id
                && o.notice.recipient_device == destination
                && !o.notice.metadata.expired(now)
                && o.consent_intent
                && o.decision == FriendDecision::Granted
                && o.notice.metadata.kind() == FriendObjectKind::File
        })
        .ok_or(ErrorCode::TransferRejected)?;
    let found = &data.incoming[index];
    if !data.friends.iter().any(|friend| {
        friend.person == found.notice.sender
            && friend.relationship == found.notice.relationship
            && friend.receive_allowed
            && friend.devices.contains(&found.issuer)
    }) {
        return Err(ErrorCode::TransferRejected.into());
    }
    Ok(index)
}

impl FriendBook {
    pub(in crate::friends) fn reserve_incoming_payload(
        &self,
        local: PeerId,
        key: TransferKey,
        manifest: &Offer,
    ) -> Result<(), TransferError> {
        let now = unix_seconds()?;
        let digest = manifest.manifest_digest()?;
        self.mutate(|state| {
            let index = allowed_payload(state, local, key, now)?;
            let granted = &mut state.incoming[index];
            if granted.payload_reserved
                || granted.notice.digest != digest
                || granted.notice.metadata.label() != manifest.name
                || granted.notice.metadata.size_bytes() != manifest.size_bytes
            {
                return Err(ErrorCode::TransferRejected.into());
            }
            granted.payload_reserved = true;
            Ok(())
        })
    }

    pub(in crate::friends) fn with_incoming_payload(
        &self,
        local: PeerId,
        key: TransferKey,
        action: impl FnOnce() -> Result<Status, TransferError>,
    ) -> Result<Status, TransferError> {
        // The live recipient runtime shares one book. Serialize final publication
        // against its revocation and permission changes.
        let _guard = self.writes.lock().map_err(|_| ErrorCode::InternalError)?;
        let data = self.read()?;
        let index = allowed_payload(&data, local, key, unix_seconds()?)?;
        if !data.incoming[index].payload_reserved {
            return Err(ErrorCode::TransferRejected.into());
        }
        action()
    }

    pub(in crate::friends) fn check_incoming_payload(
        &self,
        local: PeerId,
        key: TransferKey,
    ) -> Result<(), TransferError> {
        let data = self.read()?;
        let index = allowed_payload(&data, local, key, unix_seconds()?)?;
        if !data.incoming[index].payload_reserved {
            return Err(ErrorCode::TransferRejected.into());
        }
        Ok(())
    }

    /// Once attached, consent metadata cannot change for any recipient.
    pub fn prepare_fanout(
        &self,
        id: Uuid,
        metadata: FriendControlObject,
        now: u64,
    ) -> Result<(), TransferError> {
        metadata.validate(now)?;
        self.mutate(|state| {
            let offer = state
                .offers
                .iter_mut()
                .find(|o| o.id == id)
                .ok_or(ErrorCode::TransferRejected)?;
            if offer.withdrawn || offer.winner.is_some() {
                return Err(ErrorCode::TransferRejected.into());
            }
            match offer.presentation.as_ref() {
                Some(existing) if existing != &metadata => return Err(ErrorCode::Conflict.into()),
                Some(_) => (),
                None => offer.presentation = Some(metadata),
            }
            Ok(())
        })
    }

    pub(in crate::friends) fn outgoing_delivery(
        &self,
        id: Uuid,
        device: PeerId,
        now: u64,
    ) -> Result<Delivery, TransferError> {
        self.mutate(|state| {
            let offer = state
                .offers
                .iter_mut()
                .find(|o| {
                    o.id == id && !o.withdrawn && o.winner.is_none() && o.eligible.contains(&device)
                })
                .ok_or(ErrorCode::TransferRejected)?;
            let friend = state
                .friends
                .iter()
                .find(|friend| friend.person == offer.person && friend.devices.contains(&device))
                .ok_or(ErrorCode::TransferRejected)?;
            let metadata = offer
                .presentation
                .as_ref()
                .ok_or(ErrorCode::TransferRejected)?;
            metadata.validate(now)?;
            let ticket = if let Some((_, ticket)) = offer
                .delivery_tickets
                .iter()
                .find(|(peer, _)| *peer == device)
            {
                *ticket
            } else {
                let fresh = Uuid::new_v4();
                offer.delivery_tickets.push((device, fresh));
                fresh
            };
            Ok(Delivery {
                id,
                ticket,
                digest: offer.digest,
                sender: self.owner,
                recipient: offer.person,
                recipient_device: device,
                relationship: friend.relationship,
                metadata: metadata.clone(),
            })
        })
    }

    pub(in crate::friends) fn receive_delivery(
        &self,
        issuer: PeerId,
        local: PeerId,
        incoming: Delivery,
        now: u64,
    ) -> Result<(), TransferError> {
        incoming.metadata.validate(now)?;
        if incoming.ticket.get_version() != Some(Version::Random)
            || incoming.ticket.get_variant() != Variant::RFC4122
            || incoming.id.get_version() != Some(Version::Random)
            || incoming.id.get_variant() != Variant::RFC4122
            || incoming.recipient != self.owner
            || incoming.recipient_device != local
        {
            return Err(ErrorCode::TransferRejected.into());
        }
        self.mutate(|state| {
            if !state.friends.iter().any(|friend| {
                friend.person == incoming.sender
                    && friend.relationship == incoming.relationship
                    && friend.receive_allowed
                    && friend.devices.contains(&issuer)
            }) {
                return Err(ErrorCode::TransferRejected.into());
            }
            state
                .incoming
                .retain(|candidate| !candidate.notice.metadata.expired(now));
            if let Some(existing) = state
                .incoming
                .iter()
                .find(|cached| cached.issuer == issuer && cached.id() == incoming.id)
            {
                return if existing.notice == incoming {
                    Ok(())
                } else {
                    Err(ErrorCode::Conflict.into())
                };
            }
            if state.incoming.len() >= MAX_INCOMING {
                return Err(ErrorCode::StorageFailed.into());
            }
            state.incoming.push(FriendIncomingOffer {
                notice: incoming,
                issuer,
                decision: FriendDecision::Open,
                consent_intent: false,
                payload_reserved: false,
            });
            Ok(())
        })
    }

    pub fn incoming(&self, now: u64) -> Result<Vec<FriendIncomingOffer>, TransferError> {
        let data = self.read()?;
        Ok(data
            .incoming
            .into_iter()
            .filter(|offer| {
                !offer.notice.metadata.expired(now)
                    && data.friends.iter().any(|friend| {
                        friend.person == offer.notice.sender
                            && friend.relationship == offer.notice.relationship
                            && friend.receive_allowed
                            && friend.devices.contains(&offer.issuer)
                    })
            })
            .collect())
    }

    pub(in crate::friends) fn incoming_exact(
        &self,
        issuer: PeerId,
        local: PeerId,
        id: Uuid,
        now: u64,
    ) -> Result<FriendIncomingOffer, TransferError> {
        self.incoming(now)?
            .into_iter()
            .find(|offer| {
                offer.issuer == issuer && offer.id() == id && offer.notice.recipient_device == local
            })
            .ok_or_else(|| ErrorCode::TransferRejected.into())
    }

    pub(in crate::friends) fn store_consent_intent(
        &self,
        issuer: PeerId,
        local: PeerId,
        id: Uuid,
        now: u64,
    ) -> Result<FriendIncomingOffer, TransferError> {
        self.mutate(|state| {
            let offer = state
                .incoming
                .iter_mut()
                .find(|o| {
                    o.id() == id
                        && o.issuer == issuer
                        && o.notice.recipient_device == local
                        && !o.notice.metadata.expired(now)
                        && o.decision != FriendDecision::Withdrawn
                })
                .ok_or(ErrorCode::TransferRejected)?;
            if !state.friends.iter().any(|friend| {
                friend.person == offer.notice.sender
                    && friend.relationship == offer.notice.relationship
                    && friend.receive_allowed
                    && friend.devices.contains(&issuer)
            }) {
                return Err(ErrorCode::TransferRejected.into());
            }
            offer.consent_intent = true;
            Ok(offer.clone())
        })
    }

    pub(in crate::friends) fn update_decision(
        &self,
        issuer: PeerId,
        local: PeerId,
        id: Uuid,
        now: u64,
        decision: FriendDecision,
    ) -> Result<FriendDecision, TransferError> {
        self.mutate(|state| {
            let offer = state
                .incoming
                .iter_mut()
                .find(|o| {
                    o.id() == id
                        && o.issuer == issuer
                        && o.notice.recipient_device == local
                        && !o.notice.metadata.expired(now)
                })
                .ok_or(ErrorCode::TransferRejected)?;
            if !state.friends.iter().any(|friend| {
                friend.person == offer.notice.sender
                    && friend.relationship == offer.notice.relationship
                    && friend.receive_allowed
                    && friend.devices.contains(&issuer)
            }) {
                return Err(ErrorCode::TransferRejected.into());
            }
            if decision == FriendDecision::Granted && !offer.consent_intent {
                return Err(ErrorCode::TransferRejected.into());
            }
            if offer.decision == FriendDecision::Withdrawn
                || (offer.decision == FriendDecision::Granted && decision == FriendDecision::Open)
            {
                return Ok(offer.decision);
            }
            offer.decision = decision;
            Ok(decision)
        })
    }
}
