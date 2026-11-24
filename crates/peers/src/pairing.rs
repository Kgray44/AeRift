use aerift_transfer::{ErrorCode, PeerId, TransferError};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use subtle::ConstantTimeEq;
use tokio::{sync::watch, time::Instant};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const INVITATION_TTL: Duration = Duration::from_secs(300);
const MAX_BAD_ATTEMPTS: u8 = 12;
const MAX_REDEMPTIONS_PER_PEER: u8 = 3;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Windows,
    Ios,
    Android,
    Macos,
    Linux,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Device {
    pub id: PeerId,
    pub name: String,
    pub platform: Platform,
}

pub trait TrustStore: Send + Sync {
    fn load(&self) -> Result<Vec<Device>, TransferError>;
    fn put(&self, device: &Device) -> Result<(), TransferError>;
    fn remove(&self, peer: PeerId) -> Result<(), TransferError>;
}

pub struct InvitationCode {
    pub code: String,
    pub expires_at: SystemTime,
}

#[derive(Clone, Debug)]
pub struct PendingPairing {
    pub id: Uuid,
    pub device: Device,
    pub expires_at: SystemTime,
}

pub(crate) struct RedeemCode {
    pub peer: PeerId,
    pub token: String,
}

impl RedeemCode {
    pub fn parse(code: &str) -> Result<Self, TransferError> {
        if let Some((version, _)) = code
            .strip_prefix("aerift:")
            .and_then(|suffix| suffix.split_once(':'))
            && version != "v1"
        {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        if code.len() != "aerift:v1:".len() + 64 + 1 + 43 {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let (id, token) = code
            .strip_prefix("aerift:v1:")
            .and_then(|body| body.split_once(':'))
            .ok_or(ErrorCode::InvalidRequest)?;
        decode_token(token).ok_or(ErrorCode::InvalidRequest)?;
        Ok(Self {
            peer: id.parse()?,
            token: token.to_owned(),
        })
    }
}

#[derive(Deserialize, Serialize)]
pub(crate) struct PairRequest {
    pub token: String,
    pub name: String,
    pub platform: Platform,
}

pub struct Pairing {
    me: Device,
    store: Arc<dyn TrustStore>,
    state: Mutex<PairState>,
    pending: watch::Sender<Option<PendingPairing>>,
}

struct PairState {
    trusted: HashMap<PeerId, (Device, CancellationToken)>,
    invitation: Option<Invitation>,
}

struct Invitation {
    token: [u8; 32],
    expected: Option<PeerId>,
    deadline: Instant,
    expires_at: SystemTime,
    failures: u8,
    request: Option<Request>,
}

struct Request {
    pending: PendingPairing,
    reply: watch::Sender<Option<Result<Device, TransferError>>>,
    uses: u8,
}

impl Pairing {
    pub fn new(me: Device, store: Arc<dyn TrustStore>) -> Result<Self, TransferError> {
        if !valid_name(&me.name) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let trusted = store
            .load()?
            .into_iter()
            .map(|peer| (peer.id, (peer, CancellationToken::new())))
            .collect();
        let (pending, _) = watch::channel(None);
        Ok(Self {
            me,
            store,
            state: Mutex::new(PairState {
                trusted,
                invitation: None,
            }),
            pending,
        })
    }

    pub fn device(&self) -> &Device {
        &self.me
    }

    pub fn trusted_devices(&self) -> Vec<Device> {
        self.state()
            .trusted
            .values()
            .map(|(device, _)| device.clone())
            .collect()
    }

    pub fn is_trusted(&self, peer: PeerId) -> bool {
        self.state().trusted.contains_key(&peer)
    }

    pub(crate) fn trust(&self, peer: PeerId) -> Option<CancellationToken> {
        self.state()
            .trusted
            .get(&peer)
            .map(|(_, lease)| lease.clone())
    }

    pub fn subscribe(&self) -> watch::Receiver<Option<PendingPairing>> {
        self.pending.subscribe()
    }

    pub fn create_invitation(&self) -> Result<InvitationCode, TransferError> {
        self.create_invitation_for(None)
    }

    pub(crate) fn create_invitation_for(
        &self,
        expected: Option<PeerId>,
    ) -> Result<InvitationCode, TransferError> {
        if expected == Some(self.me.id) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let mut token = [0; 32];
        SystemRandom::new()
            .fill(&mut token)
            .map_err(|_| ErrorCode::InternalError)?;
        let deadline = Instant::now() + INVITATION_TTL;
        let expires_at = SystemTime::now() + INVITATION_TTL;
        let code = format!("aerift:v1:{}:{}", self.me.id, URL_SAFE_NO_PAD.encode(token));
        let mut state = self.state();
        self.invalidate(&mut state, ErrorCode::PairingRejected);
        state.invitation = Some(Invitation {
            token,
            expected,
            deadline,
            expires_at,
            failures: 0,
            request: None,
        });
        Ok(InvitationCode { code, expires_at })
    }

    pub fn cancel_invitation(&self) {
        self.invalidate(&mut self.state(), ErrorCode::PairingRejected);
    }

    pub(crate) fn expire_invitation(&self) {
        self.expire(&mut self.state());
    }

    pub fn confirm(&self, id: Uuid, approve: bool) -> Result<(), TransferError> {
        let mut state = self.state();
        self.expire(&mut state);
        let request = state
            .invitation
            .as_ref()
            .and_then(|invitation| invitation.request.as_ref())
            .filter(|request| request.pending.id == id && request.reply.borrow().is_none())
            .ok_or(ErrorCode::PairingExpired)?;
        if !approve {
            self.invalidate(&mut state, ErrorCode::PairingRejected);
            return Ok(());
        }
        let peer = request.pending.device.clone();
        self.store.put(&peer)?;
        request.reply.send_replace(Some(Ok(self.me.clone())));
        let entry = state
            .trusted
            .entry(peer.id)
            .or_insert_with(|| (peer.clone(), CancellationToken::new()));
        entry.0 = peer;
        self.pending.send_replace(None);
        Ok(())
    }

    pub(crate) fn record_remote(&self, device: Device) -> Result<(), TransferError> {
        if !valid_name(&device.name) || self.me.id == device.id {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let mut state = self.state();
        self.store.put(&device)?;
        let entry = state
            .trusted
            .entry(device.id)
            .or_insert_with(|| (device.clone(), CancellationToken::new()));
        entry.0 = device;
        Ok(())
    }

    pub(crate) fn remove_trust(&self, peer: PeerId) -> Result<(), TransferError> {
        let mut state = self.state();
        self.store.remove(peer)?;
        if let Some((_, lease)) = state.trusted.remove(&peer) {
            lease.cancel();
        }
        if state
            .invitation
            .as_ref()
            .and_then(|invitation| invitation.request.as_ref())
            .is_some_and(|request| request.pending.device.id == peer)
        {
            self.invalidate(&mut state, ErrorCode::PairingRejected);
        }
        Ok(())
    }

    pub(crate) async fn redeem(
        &self,
        peer: PeerId,
        body: PairRequest,
    ) -> Result<Device, TransferError> {
        let (mut reply, deadline) = {
            let mut state = self.state();
            self.expire(&mut state);
            let invitation = state.invitation.as_mut().ok_or(ErrorCode::PairingExpired)?;
            if invitation.failures >= MAX_BAD_ATTEMPTS {
                return Err(ErrorCode::PairingRejected.into());
            }
            // Authenticate the expected target before evaluating its capability.
            // Random peers cannot burn the attempt allowance of a targeted invite.
            if invitation.expected.is_some_and(|expected| expected != peer) {
                return Err(ErrorCode::PairingRejected.into());
            }
            if peer == self.me.id
                || !valid_name(&body.name)
                || !decode_token(&body.token)
                    .is_some_and(|token| bool::from(token.ct_eq(&invitation.token)))
            {
                invitation.failures += 1;
                return Err(ErrorCode::PairingRejected.into());
            }
            let request = invitation.request.get_or_insert_with(|| {
                let device = Device {
                    id: peer,
                    name: body.name,
                    platform: body.platform,
                };
                let (reply, _) = watch::channel(None);
                let pending = PendingPairing {
                    id: Uuid::new_v4(),
                    device,
                    expires_at: invitation.expires_at,
                };
                self.pending.send_replace(Some(pending.clone()));
                Request {
                    pending,
                    reply,
                    uses: 0,
                }
            });
            if request.pending.device.id != peer {
                return Err(ErrorCode::PairingRejected.into());
            }
            if request.uses >= MAX_REDEMPTIONS_PER_PEER {
                return Err(ErrorCode::PairingRejected.into());
            }
            request.uses += 1;
            (request.reply.subscribe(), invitation.deadline)
        };
        match tokio::time::timeout_at(deadline, reply.wait_for(|value| value.is_some())).await {
            Ok(Ok(value)) => value
                .clone()
                .unwrap_or_else(|| Err(ErrorCode::PairingRejected.into())),
            Ok(Err(_)) => Err(ErrorCode::PairingRejected.into()),
            Err(_) => {
                self.expire(&mut self.state());
                Err(ErrorCode::PairingExpired.into())
            }
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, PairState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn invalidate(&self, state: &mut PairState, code: ErrorCode) {
        if let Some(invitation) = state.invitation.take()
            && let Some(request) = invitation.request
        {
            request.reply.send_replace(Some(Err(code.into())));
        }
        self.pending.send_replace(None);
    }

    fn expire(&self, state: &mut PairState) {
        if state
            .invitation
            .as_ref()
            .is_some_and(|invitation| Instant::now() >= invitation.deadline)
        {
            self.invalidate(state, ErrorCode::PairingExpired);
        }
    }
}

pub(crate) fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= 120 && !name.chars().any(char::is_control)
}

fn decode_token(token: &str) -> Option<[u8; 32]> {
    if token.len() != 43 {
        return None;
    }
    URL_SAFE_NO_PAD.decode(token).ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EmptyTrust;

    impl TrustStore for EmptyTrust {
        fn load(&self) -> Result<Vec<Device>, TransferError> {
            Ok(Vec::new())
        }
        fn put(&self, _device: &Device) -> Result<(), TransferError> {
            Ok(())
        }
        fn remove(&self, _peer: PeerId) -> Result<(), TransferError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn expired_invitation_rejects_a_correct_token() {
        let me = Device {
            id: PeerId::from_tls_leaf(b"local fixture"),
            name: "Local fixture".to_owned(),
            platform: Platform::Windows,
        };
        let pairing = Pairing::new(me, Arc::new(EmptyTrust)).unwrap();
        let code = pairing.create_invitation().unwrap();
        let parsed = RedeemCode::parse(&code.code).unwrap();
        pairing.state().invitation.as_mut().unwrap().deadline = Instant::now();
        let remote = PeerId::from_tls_leaf(b"remote fixture");
        let error = pairing
            .redeem(
                remote,
                PairRequest {
                    token: parsed.token,
                    name: "Remote fixture".to_owned(),
                    platform: Platform::Ios,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::PairingExpired);
        assert!(!pairing.is_trusted(remote));
        assert!(pairing.subscribe().borrow().is_none());
    }
}
