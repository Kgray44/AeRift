use super::{DeviceEnrollment, FriendRecord, PersonId};
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
    writes: Mutex<()>,
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
}

#[derive(Deserialize, Serialize)]
struct Friend {
    person: PersonId,
    relationship: Uuid,
    devices: Vec<PeerId>,
    revoked: Vec<PeerId>,
    receive_allowed: bool,
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

impl FriendBook {
    pub fn open(owner: PersonId, store: Arc<dyn FriendStore>) -> Result<Self, TransferError> {
        Self::decode(owner, store.load()?.as_deref())?;
        Ok(Self {
            store,
            owner,
            writes: Mutex::new(()),
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
            });
        };
        if raw.len() > MAX_STORE_BYTES {
            return Err(ErrorCode::StorageFailed.into());
        }
        let data: Data = serde_json::from_slice(raw).map_err(|_| ErrorCode::StorageFailed)?;
        if data.version != 1 {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        if data.owner != owner {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        Ok(data)
    }

    fn read(&self) -> Result<Data, TransferError> {
        Self::decode(self.owner, self.store.load()?.as_deref())
    }

    fn mutate<T>(
        &self,
        f: impl FnOnce(&mut Data) -> Result<T, TransferError>,
    ) -> Result<T, TransferError> {
        let _guard = self.writes.lock().map_err(|_| ErrorCode::InternalError)?;
        let original = self.store.load()?;
        let mut data = Self::decode(self.owner, original.as_deref())?;
        let result = f(&mut data)?;
        let encoded = serde_json::to_vec(&data).map_err(|_| ErrorCode::StorageFailed)?;
        if encoded.len() > MAX_STORE_BYTES {
            return Err(ErrorCode::StorageFailed.into());
        }
        self.store.replace(original.as_deref(), &encoded)?;
        Ok(result)
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
        self.mutate(|state| {
            let friend = state
                .friends
                .iter_mut()
                .find(|friend| friend.person == person)
                .ok_or(ErrorCode::PeerUntrusted)?;
            let index = friend
                .devices
                .iter()
                .position(|candidate| *candidate == device)
                .ok_or(ErrorCode::PeerUntrusted)?;
            friend.devices.remove(index);
            friend.revoked.push(device);
            for offer in state
                .offers
                .iter_mut()
                .filter(|offer| offer.person == person)
            {
                offer.eligible.retain(|candidate| *candidate != device);
                offer.withdrawn |= offer.winner == Some(device) || offer.eligible.is_empty();
            }
            Ok(())
        })
    }

    pub fn remove(&self, person: PersonId) -> Result<(), TransferError> {
        self.mutate(|state| {
            let index = state
                .friends
                .iter()
                .position(|friend| friend.person == person)
                .ok_or(ErrorCode::PeerUntrusted)?;
            state.friends.remove(index);
            state.incoming.retain(|offer| offer.sender() != person);
            state
                .offers
                .iter_mut()
                .filter(|offer| offer.person == person)
                .for_each(|offer| offer.withdrawn = true);
            Ok(())
        })
    }

    pub fn set_receive_permission(
        &self,
        person: PersonId,
        allowed: bool,
    ) -> Result<(), TransferError> {
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
        self.mutate(|state| {
            state
                .offers
                .iter_mut()
                .find(|offer| offer.id == id)
                .ok_or(ErrorCode::TransferRejected)?
                .withdrawn = true;
            Ok(())
        })
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
