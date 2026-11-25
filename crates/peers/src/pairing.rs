use aerift_transfer::{ErrorCode, PeerId, TransferError};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
    time::{Duration, SystemTime},
};
use subtle::ConstantTimeEq;
use tokio::{sync::watch, time::Instant};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(crate) const INVITATION_TTL: Duration = Duration::from_secs(300);
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
    revocation_uncommitted: HashSet<PeerId>,
    outbound: HashMap<PeerId, Weak<CancellationToken>>,
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
                revocation_uncommitted: HashSet::new(),
                outbound: HashMap::new(),
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
        if expected.is_some_and(|peer| state.revocation_uncommitted.contains(&peer)) {
            return Err(ErrorCode::PeerUntrusted.into());
        }
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
        if state.revocation_uncommitted.contains(&peer.id) {
            return Err(ErrorCode::PeerUntrusted.into());
        }
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

    /// Fence an outbound native pairing operation before it awaits the peer.
    /// A weak reference does not retain inactive pairing operations.
    pub(crate) fn begin_outbound(
        &self,
        peer: PeerId,
    ) -> Result<Arc<CancellationToken>, TransferError> {
        let mut state = self.state();
        if state.revocation_uncommitted.contains(&peer) {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        state.outbound.retain(|_, guard| guard.strong_count() != 0);
        if let Some(existing) = state.outbound.get(&peer).and_then(Weak::upgrade) {
            return Ok(existing);
        }
        let guard = Arc::new(CancellationToken::new());
        state.outbound.insert(peer, Arc::downgrade(&guard));
        Ok(guard)
    }

    pub(crate) fn record_outbound(
        &self,
        device: Device,
        guard: &Arc<CancellationToken>,
    ) -> Result<(), TransferError> {
        let mut state = self.state();
        if guard.is_cancelled()
            || !state
                .outbound
                .get(&device.id)
                .and_then(Weak::upgrade)
                .is_some_and(|current| Arc::ptr_eq(&current, guard))
        {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        self.record_remote_locked(&mut state, device)
    }

    pub(crate) fn record_remote(&self, device: Device) -> Result<(), TransferError> {
        self.record_remote_locked(&mut self.state(), device)
    }

    fn record_remote_locked(
        &self,
        state: &mut PairState,
        device: Device,
    ) -> Result<(), TransferError> {
        if !valid_name(&device.name) || self.me.id == device.id {
            return Err(ErrorCode::InvalidRequest.into());
        }
        if state.revocation_uncommitted.contains(&device.id) {
            return Err(ErrorCode::PeerUntrusted.into());
        }
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
        if let Some(guard) = state.outbound.remove(&peer).and_then(|weak| weak.upgrade()) {
            guard.cancel();
        }
        if let Some((_, lease)) = state.trusted.remove(&peer) {
            lease.cancel();
        }
        if state.invitation.as_ref().is_some_and(|invitation| {
            invitation.expected == Some(peer)
                || invitation
                    .request
                    .as_ref()
                    .is_some_and(|request| request.pending.device.id == peer)
        }) {
            self.invalidate(&mut state, ErrorCode::PairingRejected);
        }
        // A durable store error must not keep session leases usable or let an
        // outstanding approval restore the grant. Report failure honestly and
        // quarantine this peer until that same durable removal is retried.
        let result = self.store.remove(peer);
        if result.is_err() {
            state.revocation_uncommitted.insert(peer);
        } else {
            state.revocation_uncommitted.remove(&peer);
        }
        result
    }

    pub(crate) async fn redeem(
        &self,
        peer: PeerId,
        body: PairRequest,
    ) -> Result<Device, TransferError> {
        let (mut reply, deadline) = {
            let mut state = self.state();
            self.expire(&mut state);
            if state.revocation_uncommitted.contains(&peer) {
                return Err(ErrorCode::PairingRejected.into());
            }
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

    #[derive(Default)]
    struct ControlledTrust {
        grants: Mutex<HashMap<PeerId, Device>>,
        failing: std::sync::atomic::AtomicBool,
    }
    impl TrustStore for ControlledTrust {
        fn load(&self) -> Result<Vec<Device>, TransferError> {
            Ok(self.grants.lock().unwrap().values().cloned().collect())
        }
        fn put(&self, device: &Device) -> Result<(), TransferError> {
            self.grants
                .lock()
                .unwrap()
                .insert(device.id, device.clone());
            Ok(())
        }
        fn remove(&self, peer: PeerId) -> Result<(), TransferError> {
            if self.failing.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(ErrorCode::StorageFailed.into());
            }
            self.grants.lock().unwrap().remove(&peer);
            Ok(())
        }
    }
    fn fixture(label: &'static str) -> Device {
        Device {
            id: PeerId::from_tls_leaf(label.as_bytes()),
            name: label.into(),
            platform: Platform::Windows,
        }
    }

    #[test]
    fn successful_revocation_cancels_the_exact_peer_lease_and_persists() {
        let me = fixture("local");
        let revoked = fixture("revoked");
        let other = fixture("unrelated");
        let store = Arc::new(ControlledTrust::default());
        let pairing = Pairing::new(me.clone(), store.clone()).unwrap();
        pairing.record_remote(revoked.clone()).unwrap();
        pairing.record_remote(other.clone()).unwrap();
        let original = pairing.trust(revoked.id).unwrap();
        let pending = pairing.begin_outbound(revoked.id).unwrap();
        let unrelated_pending = pairing.begin_outbound(other.id).unwrap();
        let unaffected = pairing.trust(other.id).unwrap();
        pairing.remove_trust(revoked.id).unwrap();
        assert!(original.is_cancelled());
        assert!(!unaffected.is_cancelled());
        assert!(pending.is_cancelled());
        assert!(!unrelated_pending.is_cancelled());
        assert!(pairing.record_outbound(revoked.clone(), &pending).is_err());
        let reloaded = Pairing::new(me, store).unwrap();
        assert!(!reloaded.is_trusted(revoked.id));
        assert!(reloaded.is_trusted(other.id));
        let fresh = pairing.begin_outbound(revoked.id).unwrap();
        assert!(!fresh.is_cancelled());
        pairing.record_outbound(revoked, &fresh).unwrap();
    }

    #[test]
    fn unsuccessful_persistence_removes_live_lease_but_never_claims_durability() {
        use std::sync::atomic::Ordering::SeqCst;
        let me = fixture("local");
        let revoked = fixture("retiring");
        let other = fixture("unrelated");
        let store = Arc::new(ControlledTrust::default());
        let pairing = Pairing::new(me.clone(), store.clone()).unwrap();
        pairing.record_remote(revoked.clone()).unwrap();
        pairing.record_remote(other.clone()).unwrap();
        let original = pairing.trust(revoked.id).unwrap();
        pairing.create_invitation_for(Some(revoked.id)).unwrap();
        store.failing.store(true, SeqCst);
        assert_eq!(
            pairing.remove_trust(revoked.id).unwrap_err().code,
            ErrorCode::StorageFailed
        );
        assert!(original.is_cancelled());
        assert!(pairing.trust(revoked.id).is_none());
        assert!(pairing.state().invitation.is_none());
        assert!(pairing.record_remote(revoked.clone()).is_err());
        assert!(pairing.begin_outbound(revoked.id).is_err());
        assert!(pairing.create_invitation_for(Some(revoked.id)).is_err());
        assert!(pairing.is_trusted(other.id));
        assert!(
            store
                .load()
                .unwrap()
                .iter()
                .any(|device| device.id == revoked.id)
        );
        store.failing.store(false, SeqCst);
        pairing.remove_trust(revoked.id).unwrap();
        let reloaded = Pairing::new(me, store).unwrap();
        assert!(!reloaded.is_trusted(revoked.id));
        assert!(reloaded.is_trusted(other.id));
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
