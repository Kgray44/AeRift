use super::{
    DelegatedFriendMember, DeviceEnrollment, FriendProfileCursor, FriendRecord, PersonId,
    SharedFriendProfile, VerifiedFriendProfile,
};
use aerift_transfer::{ErrorCode, PeerId, TransferError};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use uuid::{Uuid, Variant, Version};

#[path = "admission.rs"]
mod admission;
#[path = "fanout.rs"]
mod fanout;
pub use admission::{FriendInviteEndpoint, FriendInviteState};
pub(super) use fanout::Delivery;
pub use fanout::{FriendControlObject, FriendIncomingOffer, FriendObjectKind};

const MAX_FRIENDS: usize = 256;
const MAX_DEVICES: usize = 32;
const MAX_OFFERS: usize = 1024;
const MAX_USED: usize = 4096;
const MAX_STORE_BYTES: usize = 8 * 1024 * 1024;

/// Platform-owned, independent of Nearby / My Devices / Remote peer stores.
/// `replace` must provide an atomic durable compare-and-swap and must never
/// acknowledge a write that can be lost after a process restart.
pub trait FriendStore: Send + Sync {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError>;
    fn replace(&self, expected: Option<&[u8]>, data: &[u8]) -> Result<(), TransferError>;
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum FriendClaim {
    Awarded,
    AlreadyAwarded,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub enum FriendDecision {
    Open,
    Granted,
    Withdrawn,
}

pub struct FriendBook {
    store: Arc<dyn FriendStore>,
    owner: PersonId,
    // Serialize the mutation + durable commit, and reject stale writers via CAS.
    writes: Mutex<Vec<Restriction>>,
    // Only explicit live person offers register a one-shot readiness signal.
    ready: Mutex<std::collections::HashMap<Uuid, tokio::sync::oneshot::Sender<PeerId>>>,
}

// You may remove authorization while storage is unhealthy, but never create
// it from this overlay. A new process has only the durable ledger.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Restriction {
    Device(PersonId, PeerId),
    Person(PersonId),
    NoReceive(PersonId),
    Offer(Uuid),
}

impl Restriction {
    fn apply(self, state: &mut Data) -> Result<(), TransferError> {
        match self {
            Self::Device(person, device) => {
                let friend = state
                    .friends
                    .iter_mut()
                    .find(|f| f.person == person)
                    .ok_or(ErrorCode::PeerUntrusted)?;
                let index = friend
                    .devices
                    .iter()
                    .position(|peer| *peer == device)
                    .ok_or(ErrorCode::PeerUntrusted)?;
                friend.devices.remove(index);
                friend.revoked.push(device);
                if let Some(stored) = friend
                    .profile
                    .as_mut()
                    .filter(|record| record.origin == device)
                {
                    // Keep the relationship-wide replay floor without keeping revoked presentation.
                    stored.presentation = None;
                }
                for offer in state.offers.iter_mut().filter(|o| o.person == person) {
                    offer.eligible.retain(|peer| *peer != device);
                    offer.withdrawn |= offer.winner == Some(device) || offer.eligible.is_empty();
                }
            }
            Self::Person(person) => {
                let index = state
                    .friends
                    .iter()
                    .position(|f| f.person == person)
                    .ok_or(ErrorCode::PeerUntrusted)?;
                state.friends.remove(index);
                state.incoming.retain(|o| o.sender() != person);
                state
                    .offers
                    .iter_mut()
                    .filter(|o| o.person == person)
                    .for_each(|o| o.withdrawn = true);
            }
            Self::NoReceive(person) => {
                state
                    .friends
                    .iter_mut()
                    .find(|f| f.person == person)
                    .ok_or(ErrorCode::PeerUntrusted)?
                    .receive_allowed = false;
            }
            Self::Offer(id) => {
                state
                    .offers
                    .iter_mut()
                    .find(|o| o.id == id)
                    .ok_or(ErrorCode::TransferRejected)?
                    .withdrawn = true;
            }
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
struct Data {
    version: u8,
    owner: PersonId,
    used: Vec<Uuid>,
    friends: Vec<Friend>,
    offers: Vec<Offer>,
    #[serde(default)]
    incoming: Vec<FriendIncomingOffer>,
    #[serde(default)]
    invites: Vec<admission::PendingInvite>,
    #[serde(default)]
    enrollments: Vec<admission::PendingEnrollment>,
    #[serde(default)]
    consent_drafts: Vec<admission::RecipientConsent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    member: Option<DelegatedFriendMember>,
}

#[derive(Deserialize, Serialize)]
struct Friend {
    person: PersonId,
    relationship: Uuid,
    devices: Vec<PeerId>,
    revoked: Vec<PeerId>,
    receive_allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transcript: Option<super::authority::FriendshipTranscript>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<StoredProfile>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredProfile {
    cursor: FriendProfileCursor,
    origin: PeerId,
    presentation: Option<SharedFriendProfile>,
}

#[derive(Deserialize, Serialize)]
struct Offer {
    id: Uuid,
    person: PersonId,
    eligible: Vec<PeerId>,
    digest: [u8; 32],
    winner: Option<PeerId>,
    started: bool,
    withdrawn: bool,
    #[serde(default)]
    presentation: Option<FriendControlObject>,
    #[serde(default)]
    delivery_tickets: Vec<(PeerId, Uuid)>,
}

pub struct FriendContactView {
    pub person: PersonId,
    pub devices: Vec<PeerId>,
    pub receive_allowed: bool,
}

impl FriendBook {
    /// Read-only validation for a prospective local approval. Never signs.
    pub fn delegation_candidate(
        &self,
        person: PersonId,
        device: PeerId,
    ) -> Result<Uuid, TransferError> {
        let current = self.read()?;
        if current.member.is_some() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        let row = current
            .friends
            .iter()
            .find(|f| f.person == person)
            .ok_or(ErrorCode::PeerUntrusted)?;
        if row.transcript.is_none() {
            return Err(ErrorCode::PairingRejected.into());
        }
        if row.devices.contains(&device) || row.revoked.contains(&device) {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        Ok(row.relationship)
    }

    /// Root-device action after explicit validation of the new device
    /// fingerprint. This issues signed material, not a friendship or remote grant.
    pub fn delegate_contact(
        &self,
        authority: &super::FriendAuthority,
        person: PersonId,
        device: PeerId,
        now: u64,
    ) -> Result<DelegatedFriendMember, TransferError> {
        let current = self.read()?;
        if current.owner != authority.id() || current.member.is_some() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        let row = current
            .friends
            .into_iter()
            .find(|entry| entry.person == person)
            .ok_or(ErrorCode::PeerUntrusted)?;
        let transcript = row.transcript.ok_or(ErrorCode::PairingRejected)?;
        if row.revoked.contains(&device) || row.devices.contains(&device) {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        let grant = authority.enroll(row.relationship, device, now)?;
        let member = DelegatedFriendMember::new(
            transcript.invitation,
            transcript.acceptance,
            transcript.approval,
            grant,
        );
        member.record(device, now)?;
        Ok(member)
    }

    /// Open a previously joined member profile from an independent protected
    /// store. No root signing API or secret material is returned to this device.
    pub fn open_delegated(
        identity: &crate::Identity,
        store: Arc<dyn FriendStore>,
    ) -> Result<Self, TransferError> {
        let data = store.load()?.ok_or(ErrorCode::PeerUntrusted)?;
        if data.len() > MAX_STORE_BYTES {
            return Err(ErrorCode::StorageFailed.into());
        }
        let stored: Data = serde_json::from_slice(&data).map_err(|_| ErrorCode::StorageFailed)?;
        let delegation = stored.member.as_ref().ok_or(ErrorCode::PeerUntrusted)?;
        let record = delegation.record(identity.id(), delegation.issued())?;
        if record.owner != stored.owner || !stored.used.contains(&record.nonce) {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        Self::open(record.owner, store)
    }

    /// A fresh member store must be protected/locked by the platform. Verify all
    /// local proof before dialing the original friend's exact pinned device.
    /// The signed delegation and reciprocal roster row commit in one CAS.
    pub async fn join_delegated(
        identity: &crate::Identity,
        store: Arc<dyn FriendStore>,
        member: DelegatedFriendMember,
        routes: &[std::net::SocketAddr],
        ticket: Uuid,
    ) -> Result<Self, TransferError> {
        let now = super::wire::wall_clock()?;
        let record = member.record(identity.id(), now)?;
        if store.load()?.is_some() {
            return Err(ErrorCode::Conflict.into());
        }
        FriendInviteEndpoint::prove_exact_device(
            identity,
            routes,
            record.primary,
            ticket,
            member.grant().clone(),
        )
        .await?;
        let current = super::wire::wall_clock()?;
        let book = Self::open(record.owner, store)?;
        book.mutate(|data| {
            if data.member.is_some() || !data.used.is_empty() || !data.friends.is_empty() {
                return Err(ErrorCode::Conflict.into());
            }
            Self::add_record(data, record, current)?;
            data.member = Some(member);
            Ok(())
        })?;
        Ok(book)
    }

    pub(super) fn profile_owner(&self) -> PersonId {
        self.owner
    }

    /// Resolve only an existing person with a currently enrolled pinned
    /// device. A local revocation overlay is part of the read.
    pub(super) fn profile_relationship(
        &self,
        person: PersonId,
        authenticated_device: PeerId,
    ) -> Result<Uuid, TransferError> {
        self.read()?
            .friends
            .into_iter()
            .find(|friend| {
                friend.person == person && friend.devices.contains(&authenticated_device)
            })
            .map(|friend| friend.relationship)
            .ok_or_else(|| ErrorCode::PeerUntrusted.into())
    }

    /// Called only with a live, pinned and authenticated Friends session.
    /// The verified profile and the relationship-wide revision floor enter
    /// the existing protected store in one compare-and-swap.
    pub fn apply_shared_profile(
        &self,
        wire: &[u8],
        self_device: PeerId,
        authenticated_sender: PeerId,
        now: u64,
    ) -> Result<(), TransferError> {
        let verified =
            self.verify_shared_profile(wire, self_device, authenticated_sender, now, None)?;
        self.mutate(|state| {
            let friend = state
                .friends
                .iter_mut()
                .find(|friend| {
                    friend.person == verified.cursor.issuer
                        && friend.relationship == verified.cursor.relationship
                        && friend.devices.contains(&authenticated_sender)
                })
                .ok_or(ErrorCode::PeerUntrusted)?;
            if friend
                .profile
                .as_ref()
                .is_some_and(|current| current.cursor.revision >= verified.cursor.revision)
            {
                return Err(ErrorCode::Conflict.into());
            }
            friend.profile = Some(StoredProfile {
                cursor: verified.cursor,
                origin: authenticated_sender,
                presentation: Some(verified.profile),
            });
            // Older builds rejected all non-v1 ledgers. Do not let a
            // downgrade silently drop the floor on its next write.
            state.version = 2;
            Ok(())
        })
    }

    /// Reads a presentation only through the currently active relationship
    /// with an enrolled origin; this is a snapshot, not a lasting cache grant.
    pub fn shared_profile(
        &self,
        person: PersonId,
    ) -> Result<Option<VerifiedFriendProfile>, TransferError> {
        let data = self.read()?;
        let stored = data
            .friends
            .into_iter()
            .find(|friend| friend.person == person)
            .and_then(|friend| {
                friend
                    .profile
                    .filter(|profile| friend.devices.contains(&profile.origin))
            });
        let Some((cursor, profile)) =
            stored.and_then(|stored| stored.presentation.map(|profile| (stored.cursor, profile)))
        else {
            return Ok(None);
        };
        // Validate the one projected presentation, not every avatar on every
        // unrelated book operation (e.g. offer reconciliation).
        profile.validate().map_err(|_| ErrorCode::StorageFailed)?;
        Ok(Some(VerifiedFriendProfile { cursor, profile }))
    }

    pub fn contacts(&self) -> Result<Vec<FriendContactView>, TransferError> {
        Ok(self
            .read()?
            .friends
            .into_iter()
            .map(|f| FriendContactView {
                person: f.person,
                devices: f.devices,
                receive_allowed: f.receive_allowed,
            })
            .collect())
    }

    pub fn contact_id(&self, id: &str) -> Result<PersonId, TransferError> {
        self.contacts()?
            .into_iter()
            .find(|f| f.person.to_string() == id)
            .map(|f| f.person)
            .ok_or_else(|| ErrorCode::PeerUntrusted.into())
    }
    pub fn open(owner: PersonId, store: Arc<dyn FriendStore>) -> Result<Self, TransferError> {
        Self::decode(owner, store.load()?.as_deref())?;
        Ok(Self {
            store,
            owner,
            writes: Mutex::new(Vec::new()),
            ready: Mutex::new(std::collections::HashMap::new()),
        })
    }

    fn decode(owner: PersonId, raw: Option<&[u8]>) -> Result<Data, TransferError> {
        let Some(raw) = raw else {
            return Ok(Data {
                version: 1,
                owner,
                used: Vec::new(),
                friends: Vec::new(),
                offers: Vec::new(),
                incoming: Vec::new(),
                invites: Vec::new(),
                enrollments: Vec::new(),
                consent_drafts: Vec::new(),
                member: None,
            });
        };
        if raw.len() > MAX_STORE_BYTES {
            return Err(ErrorCode::StorageFailed.into());
        }
        let data: Data = serde_json::from_slice(raw).map_err(|_| ErrorCode::StorageFailed)?;
        if data.version != 1 && data.version != 2 {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        if data.owner != owner {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        for friend in &data.friends {
            if let Some(profile) = &friend.profile {
                if data.version != 2
                    || profile.cursor.issuer != friend.person
                    || profile.cursor.recipient != owner
                    || profile.cursor.relationship != friend.relationship
                    || !profile.cursor.version_valid()
                    || profile.presentation.is_some() != friend.devices.contains(&profile.origin)
                    || (profile.presentation.is_none() && !friend.revoked.contains(&profile.origin))
                {
                    return Err(ErrorCode::StorageFailed.into());
                }
            }
        }
        Ok(data)
    }

    fn read(&self) -> Result<Data, TransferError> {
        let overlays = self.writes.lock().map_err(|_| ErrorCode::InternalError)?;
        self.read_with(&overlays)
    }

    fn read_with(&self, overlays: &[Restriction]) -> Result<Data, TransferError> {
        let raw = self.store.load()?;
        let mut data = Self::decode(self.owner, raw.as_deref())?;
        Self::apply_restrictions(&mut data, overlays);
        Ok(data)
    }

    fn apply_restrictions(data: &mut Data, restrictions: &[Restriction]) {
        for restriction in restrictions {
            // Already absent/removed is stricter than pending removal.
            let _ = restriction.apply(data);
        }
    }

    fn store_data(&self, original: Option<&[u8]>, data: &Data) -> Result<(), TransferError> {
        let encoded = serde_json::to_vec(data).map_err(|_| ErrorCode::StorageFailed)?;
        if encoded.len() > MAX_STORE_BYTES {
            return Err(ErrorCode::StorageFailed.into());
        }
        self.store.replace(original, &encoded)
    }

    fn mutate<T>(
        &self,
        f: impl FnOnce(&mut Data) -> Result<T, TransferError>,
    ) -> Result<T, TransferError> {
        let mut pending = self.writes.lock().map_err(|_| ErrorCode::InternalError)?;
        let original = self.store.load()?;
        let mut data = Self::decode(self.owner, original.as_deref())?;
        Self::apply_restrictions(&mut data, &pending);
        let result = f(&mut data)?;
        self.store_data(original.as_deref(), &data)?;
        pending.clear();
        Ok(result)
    }

    fn restrict(&self, restriction: Restriction) -> Result<(), TransferError> {
        let mut pending = self.writes.lock().map_err(|_| ErrorCode::InternalError)?;
        let original = self.store.load()?;
        let mut data = Self::decode(self.owner, original.as_deref())?;
        Self::apply_restrictions(&mut data, &pending);
        if !pending.contains(&restriction) {
            restriction.apply(&mut data)?;
            pending.push(restriction);
        }
        // Keep the live restriction even when durable storage fails. Any
        // later protected write includes all currently pending restrictions.
        self.store_data(original.as_deref(), &data)?;
        pending.clear();
        Ok(())
    }

    pub fn add(&self, friend: FriendRecord, now: u64) -> Result<(), TransferError> {
        self.mutate(|state| Self::add_record(state, friend, now))
    }

    fn add_record(state: &mut Data, friend: FriendRecord, now: u64) -> Result<(), TransferError> {
        if friend.owner != state.owner {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        if now >= friend.expires {
            return Err(ErrorCode::PairingExpired.into());
        }
        if state.used.contains(&friend.nonce)
            || state.friends.iter().any(|existing| {
                existing.person == friend.person || existing.devices.contains(&friend.primary)
            })
            || state.friends.len() >= MAX_FRIENDS
            || state.used.len() >= MAX_USED
        {
            return Err(ErrorCode::Conflict.into());
        }
        state.used.push(friend.nonce);
        state.friends.push(Friend {
            person: friend.person,
            relationship: friend.nonce,
            devices: vec![friend.primary],
            revoked: Vec::new(),
            receive_allowed: true,
            transcript: Some(friend.transcript),
            profile: None,
        });
        Ok(())
    }

    /// Admission is a scoped local UI decision in addition to the person-signed
    /// enrollment and a native mTLS session with the enrolled device.
    pub fn enroll(
        &self,
        enrollment: DeviceEnrollment,
        authenticated_device: PeerId,
        now: u64,
    ) -> Result<(), TransferError> {
        self.mutate(|state| Self::enroll_record(state, &enrollment, authenticated_device, now))
    }

    fn enroll_record(
        state: &mut Data,
        enrollment: &DeviceEnrollment,
        authenticated_device: PeerId,
        now: u64,
    ) -> Result<(), TransferError> {
        enrollment.verify(authenticated_device, now)?;
        if state
            .friends
            .iter()
            .any(|friend| friend.devices.contains(&enrollment.device))
        {
            return Err(ErrorCode::Conflict.into());
        }
        let friend = state
            .friends
            .iter_mut()
            .find(|friend| friend.person == enrollment.person)
            .ok_or(ErrorCode::PeerUntrusted)?;
        if friend.relationship != enrollment.relationship
            || friend.revoked.contains(&enrollment.device)
            || friend.devices.len() + friend.revoked.len() >= MAX_DEVICES
        {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        friend.devices.push(enrollment.device);
        Ok(())
    }

    pub fn revoke_device(&self, person: PersonId, device: PeerId) -> Result<(), TransferError> {
        self.restrict(Restriction::Device(person, device))
    }

    pub fn remove(&self, person: PersonId) -> Result<(), TransferError> {
        self.restrict(Restriction::Person(person))
    }

    pub fn set_receive_permission(
        &self,
        person: PersonId,
        allowed: bool,
    ) -> Result<(), TransferError> {
        if !allowed {
            return self.restrict(Restriction::NoReceive(person));
        }
        self.mutate(|state| {
            state
                .friends
                .iter_mut()
                .find(|friend| friend.person == person)
                .ok_or(ErrorCode::PeerUntrusted)?
                .receive_allowed = allowed;
            Ok(())
        })
    }

    /// A policy precheck, never recipient approval or stream authorization.
    pub fn may_receive_from(
        &self,
        person: PersonId,
        authenticated_device: PeerId,
    ) -> Result<bool, TransferError> {
        Ok(self.read()?.friends.iter().any(|friend| {
            friend.person == person
                && friend.receive_allowed
                && friend.devices.contains(&authenticated_device)
        }))
    }

    /// Sender creates one stable offer and captures only currently enrolled
    /// eligible devices. The digest is a hash of a canonical immutable manifest.
    pub fn offer(
        &self,
        id: Uuid,
        person: PersonId,
        device: Option<PeerId>,
        digest: [u8; 32],
    ) -> Result<(), TransferError> {
        if id.get_version() != Some(Version::Random) || id.get_variant() != Variant::RFC4122 {
            return Err(ErrorCode::InvalidRequest.into());
        }
        self.mutate(|state| {
            if state.offers.iter().any(|offer| offer.id == id) || state.offers.len() >= MAX_OFFERS {
                return Err(ErrorCode::Conflict.into());
            }
            let eligible: Vec<_> = state
                .friends
                .iter()
                .find(|friend| friend.person == person)
                .ok_or(ErrorCode::PeerUntrusted)?
                .devices
                .iter()
                .copied()
                .filter(|candidate| device.is_none_or(|device| *candidate == device))
                .collect();
            if eligible.is_empty() {
                return Err(ErrorCode::PeerUnavailable.into());
            }
            state.offers.push(Offer {
                id,
                person,
                eligible,
                digest,
                winner: None,
                started: false,
                withdrawn: false,
                presentation: None,
                delivery_tickets: Vec::new(),
            });
            Ok(())
        })
    }

    /// The adapter calls this only for explicit acceptance over the authenticated
    /// friendship transport. Snapshot membership, revocation, manifest and
    /// winner selection are checked in the same durable transaction.
    pub fn claim(
        &self,
        id: Uuid,
        device: PeerId,
        digest: [u8; 32],
    ) -> Result<FriendClaim, TransferError> {
        self.claim_at(id, device, digest, None, fanout::unix_seconds()?)
    }

    pub(super) fn claim_at(
        &self,
        id: Uuid,
        device: PeerId,
        digest: [u8; 32],
        ticket: Option<Uuid>,
        now: u64,
    ) -> Result<FriendClaim, TransferError> {
        self.mutate(|state| {
            let offer = state
                .offers
                .iter_mut()
                .find(|offer| offer.id == id)
                .ok_or(ErrorCode::TransferRejected)?;
            if offer.withdrawn
                || offer
                    .presentation
                    .as_ref()
                    .is_some_and(|object| object.expired(now))
                || ticket.is_some_and(|ticket| !offer.delivery_tickets.contains(&(device, ticket)))
                || offer.digest != digest
                || !offer.eligible.contains(&device)
            {
                return Err(ErrorCode::TransferRejected.into());
            }
            match offer.winner {
                Some(winner) if winner == device => Ok(FriendClaim::AlreadyAwarded),
                Some(_) => Err(ErrorCode::Conflict.into()),
                None => {
                    offer.winner = Some(device);
                    Ok(FriendClaim::Awarded)
                }
            }
        })
    }

    pub(super) fn arm_person_ready(
        &self,
        id: Uuid,
    ) -> Result<tokio::sync::oneshot::Receiver<PeerId>, TransferError> {
        let mut entries = self.ready.lock().map_err(|_| ErrorCode::InternalError)?;
        if entries.len() >= 8 || entries.contains_key(&id) {
            return Err(ErrorCode::Conflict.into());
        }
        let (send, receive) = tokio::sync::oneshot::channel();
        entries.insert(id, send);
        Ok(receive)
    }

    pub(super) fn disarm_person_ready(&self, id: Uuid) {
        if let Ok(mut entries) = self.ready.lock() {
            entries.remove(&id);
        }
    }

    /// Only the exact already committed winner may attest that its local
    /// consent is durable and its payload receiver is ready.
    pub(super) fn note_person_ready(
        &self,
        id: Uuid,
        peer: PeerId,
        digest: [u8; 32],
        ticket: Uuid,
    ) -> Result<(), TransferError> {
        if self.decision(id, peer, digest, ticket)? != FriendDecision::Granted {
            return Err(ErrorCode::TransferRejected.into());
        }
        if let Some(send) = self
            .ready
            .lock()
            .map_err(|_| ErrorCode::InternalError)?
            .remove(&id)
        {
            let _ = send.send(peer);
        }
        Ok(())
    }

    /// Produce only another device's own terminal disposition, scoped by
    /// its original delivery ticket. Do not include the winner's identity.
    pub(super) fn loser_notice(
        &self,
        id: Uuid,
        device: PeerId,
    ) -> Result<Option<([u8; 32], Uuid)>, TransferError> {
        let state = self.read()?;
        let offer = state
            .offers
            .iter()
            .find(|offer| offer.id == id)
            .ok_or(ErrorCode::TransferRejected)?;
        if offer.winner.is_none() || offer.winner == Some(device) {
            return Ok(None);
        }
        Ok(offer
            .delivery_tickets
            .iter()
            .find(|(peer, _)| *peer == device)
            .map(|(_, ticket)| (offer.digest, *ticket)))
    }

    /// Current disposition for a device included in the specific offer.
    /// Unauthorized callers cannot enumerate offers or learn a winner's ID.
    pub(super) fn decision(
        &self,
        id: Uuid,
        device: PeerId,
        digest: [u8; 32],
        ticket: Uuid,
    ) -> Result<FriendDecision, TransferError> {
        let data = self.read()?;
        let offer = data
            .offers
            .iter()
            .find(|offer| offer.id == id)
            .filter(|o| {
                o.digest == digest
                    && o.eligible.contains(&device)
                    && o.delivery_tickets.contains(&(device, ticket))
            })
            .ok_or(ErrorCode::TransferRejected)?;
        let now = fanout::unix_seconds()?;
        let expired = offer
            .presentation
            .as_ref()
            .is_some_and(|object| object.expired(now));
        Ok(match (offer.withdrawn || expired, offer.winner) {
            (true, _) => FriendDecision::Withdrawn,
            (_, None) => FriendDecision::Open,
            (_, Some(winner)) if winner == device => FriendDecision::Granted,
            (_, Some(_)) => FriendDecision::Withdrawn,
        })
    }

    /// For rendering status. Always consider the award immutable, even when
    /// revocation or cancellation prevents that winner from collecting it.
    pub fn winner(&self, id: Uuid) -> Result<Option<PeerId>, TransferError> {
        self.read()?
            .offers
            .iter()
            .find(|offer| offer.id == id)
            .map(|offer| offer.winner)
            .ok_or_else(|| ErrorCode::TransferRejected.into())
    }

    pub fn withdraw(&self, id: Uuid) -> Result<(), TransferError> {
        self.restrict(Restriction::Offer(id))
    }

    pub fn authorize_payload(
        &self,
        id: Uuid,
        device: PeerId,
        digest: [u8; 32],
    ) -> Result<(), TransferError> {
        let now = fanout::unix_seconds()?;
        let data = self.read()?;
        let offer = data
            .offers
            .iter()
            .find(|offer| offer.id == id)
            .ok_or(ErrorCode::TransferRejected)?;
        if !offer.withdrawn
            && offer
                .presentation
                .as_ref()
                .is_none_or(|object| !object.expired(now))
            && offer.digest == digest
            && offer.winner == Some(device)
            && offer.eligible.contains(&device)
        {
            return Ok(());
        }
        Err(ErrorCode::TransferRejected.into())
    }

    /// One-use durable stream-start admission; use the immutable same winner for
    /// any future resume route instead of awarding a second target after failure.
    pub fn begin_payload(
        &self,
        id: Uuid,
        device: PeerId,
        digest: [u8; 32],
    ) -> Result<(), TransferError> {
        let now = fanout::unix_seconds()?;
        self.mutate(|data| {
            let offer = data
                .offers
                .iter_mut()
                .find(|offer| offer.id == id)
                .ok_or(ErrorCode::TransferRejected)?;
            if offer.withdrawn
                || offer
                    .presentation
                    .as_ref()
                    .is_some_and(|object| object.expired(now))
                || offer.digest != digest
                || offer.winner != Some(device)
                || !offer.eligible.contains(&device)
            {
                return Err(ErrorCode::TransferRejected.into());
            }
            if offer.started {
                return Err(ErrorCode::Conflict.into());
            }
            offer.started = true;
            Ok(())
        })
    }
}
