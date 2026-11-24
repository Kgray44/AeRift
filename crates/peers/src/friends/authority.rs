use crate::SecretStore;
use aerift_transfer::{ErrorCode, PeerId, TransferError};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    rand::SystemRandom,
    signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey},
};
use serde::{Deserialize, Serialize};
use uuid::{Uuid, Version};

const TTL: u64 = 300;
const CARD_TTL: u64 = 24 * 60 * 60;
const CARD_PREFIX: &str = "aerift:friend-card:v1:";
const MAX_CARD_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct PersonId([u8; 32]);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContactCard(PersonId, PeerId, u64, u64, String);

#[derive(Serialize, Deserialize)]
pub struct FriendInvitation {
    nonce: Uuid,
    issuer: PersonId,
    issuer_device: PeerId,
    recipient: PersonId,
    recipient_device: PeerId,
    issued: u64,
    expires: u64,
    signature: String,
}

#[derive(Serialize, Deserialize)]
pub struct FriendAcceptance(String);
#[derive(Serialize, Deserialize)]
pub struct FriendApproval(String);

#[derive(Serialize, Deserialize)]
pub struct DeviceEnrollment {
    pub(super) person: PersonId,
    pub(super) device: PeerId,
    pub(super) relationship: Uuid,
    issued: u64,
    expires: u64,
    signature: String,
}

#[derive(Clone)]
pub struct FriendRecord {
    pub(super) person: PersonId,
    pub(super) owner: PersonId,
    pub(super) primary: PeerId,
    pub(super) nonce: Uuid,
    pub(super) expires: u64,
}

pub struct FriendAuthority(Ed25519KeyPair);

fn canonical(value: impl Serialize) -> Result<Vec<u8>, TransferError> {
    serde_json::to_vec(&value).map_err(|_| ErrorCode::InvalidRequest.into())
}
fn verify(key: PersonId, bytes: &[u8], encoded: &str) -> Result<(), TransferError> {
    if encoded.len() != 86 {
        return Err(ErrorCode::PairingRejected.into());
    }
    let signature = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| ErrorCode::PairingRejected)?;
    UnparsedPublicKey::new(&ED25519, key.0)
        .verify(bytes, &signature)
        .map_err(|_| ErrorCode::PairingRejected.into())
}
fn valid_time(issued: u64, expires: u64, now: u64) -> bool {
    expires.checked_sub(issued) == Some(TTL) && (issued..expires).contains(&now)
}

impl FriendInvitation {
    fn body(&self) -> impl Serialize + '_ {
        (
            self.nonce,
            self.issuer,
            self.issuer_device,
            self.recipient,
            self.recipient_device,
            self.issued,
            self.expires,
        )
    }

    fn verify(&self, now: u64) -> Result<(), TransferError> {
        if !valid_time(self.issued, self.expires, now) {
            return Err(ErrorCode::PairingExpired.into());
        }
        if self.issuer == self.recipient
            || self.issuer_device == self.recipient_device
            || self.nonce.get_version() != Some(Version::Random)
            || self.nonce.get_variant() != uuid::Variant::RFC4122
        {
            return Err(ErrorCode::PairingRejected.into());
        }
        verify(
            self.issuer,
            &canonical(("aerift/friends/invite/1", self.body()))?,
            &self.signature,
        )
    }
}

impl FriendAcceptance {
    fn verify(&self, invite: &FriendInvitation) -> Result<(), TransferError> {
        verify(
            invite.recipient,
            &canonical(("aerift/friends/accept/1", invite.body(), &invite.signature))?,
            &self.0,
        )
    }
}

impl DeviceEnrollment {
    fn body(&self) -> impl Serialize {
        (
            self.person,
            self.device,
            self.relationship,
            self.issued,
            self.expires,
        )
    }
    pub(super) fn verify(
        &self,
        authenticated_device: PeerId,
        now: u64,
    ) -> Result<(), TransferError> {
        if self.device != authenticated_device {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        if !valid_time(self.issued, self.expires, now) {
            return Err(ErrorCode::PairingExpired.into());
        }
        verify(
            self.person,
            &canonical(("aerift/friends/enroll/1", self.body()))?,
            &self.signature,
        )
    }
}

impl FriendAuthority {
    /// Use a separate platform-protected, atomic identity store. No certificate or LAN
    /// trust entry grants access to this person-level signing key.
    pub fn load_or_create(store: &(impl SecretStore + ?Sized)) -> Result<Self, TransferError> {
        let data = match store.load()? {
            Some(key) => key,
            None => {
                let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                    .map_err(|_| ErrorCode::StorageFailed)?;
                store.initialize(key.as_ref())?
            }
        };
        Ed25519KeyPair::from_pkcs8(&data)
            .map(Self)
            .map_err(|_| ErrorCode::StorageFailed.into())
    }
    pub fn id(&self) -> PersonId {
        let mut key = [0; 32];
        key.copy_from_slice(self.0.public_key().as_ref());
        PersonId(key)
    }

    fn sign(&self, bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(self.0.sign(bytes))
    }

    /// Deliberate, private exchange only. The card is not an invitation and
    /// conveys no authorization or discoverability.
    pub fn contact_card(&self, device: PeerId, now: u64) -> Result<String, TransferError> {
        let person = self.id();
        let expires = now.checked_add(CARD_TTL).ok_or(ErrorCode::InvalidRequest)?;
        let signature = self.sign(&canonical((
            "aerift/friends/contact/1",
            person,
            device,
            now,
            expires,
        ))?);
        Ok(format!(
            "{CARD_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(canonical(ContactCard(
                person, device, now, expires, signature
            ))?)
        ))
    }

    /// Validate the card before creating an exact-device, exact-person invite.
    /// The host still needs explicit human confirmation of the card fingerprint
    /// over an already-known private channel.
    pub fn invite_contact(
        &self,
        issuer_device: PeerId,
        card: &str,
        now: u64,
    ) -> Result<FriendInvitation, TransferError> {
        if card.len() > MAX_CARD_BYTES {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let raw = URL_SAFE_NO_PAD
            .decode(
                card.strip_prefix(CARD_PREFIX)
                    .ok_or(ErrorCode::InvalidRequest)?,
            )
            .map_err(|_| ErrorCode::InvalidRequest)?;
        let ContactCard(person, device, issued, expires, signature) =
            serde_json::from_slice(&raw).map_err(|_| ErrorCode::InvalidRequest)?;
        if expires.checked_sub(issued) != Some(CARD_TTL) || !(issued..expires).contains(&now) {
            return Err(ErrorCode::PairingExpired.into());
        }
        verify(
            person,
            &canonical(("aerift/friends/contact/1", person, device, issued, expires))?,
            &signature,
        )?;
        self.invite(issuer_device, person, device, now)
    }

    /// Explicit issuer action. Recipient key and pinned device were provided privately.
    pub fn invite(
        &self,
        issuer_device: PeerId,
        recipient: PersonId,
        recipient_device: PeerId,
        now: u64,
    ) -> Result<FriendInvitation, TransferError> {
        let mut invitation = FriendInvitation {
            nonce: Uuid::new_v4(),
            issuer: self.id(),
            issuer_device,
            recipient,
            recipient_device,
            issued: now,
            expires: now.checked_add(TTL).ok_or(ErrorCode::InvalidRequest)?,
            signature: String::new(),
        };
        invitation.signature =
            self.sign(&canonical(("aerift/friends/invite/1", invitation.body()))?);
        invitation.verify(now)?;
        Ok(invitation)
    }

    /// Call only after invitee's explicit UI consent and a completed mTLS session.
    pub fn accept(
        &self,
        invite: &FriendInvitation,
        authenticated_issuer: PeerId,
        local_device: PeerId,
        now: u64,
    ) -> Result<FriendAcceptance, TransferError> {
        invite.verify(now)?;
        if invite.recipient != self.id()
            || invite.recipient_device != local_device
            || invite.issuer_device != authenticated_issuer
        {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        Ok(FriendAcceptance(self.sign(&canonical((
            "aerift/friends/accept/1",
            invite.body(),
            &invite.signature,
        ))?)))
    }

    /// Call only after issuer's confirmation of the authenticated acceptance.
    pub fn confirm(
        &self,
        invite: &FriendInvitation,
        acceptance: &FriendAcceptance,
        authenticated_recipient: PeerId,
        now: u64,
    ) -> Result<FriendApproval, TransferError> {
        invite.verify(now)?;
        if invite.issuer != self.id() || invite.recipient_device != authenticated_recipient {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        acceptance.verify(invite)?;
        Ok(FriendApproval(self.sign(&canonical((
            "aerift/friends/confirm/1",
            invite.body(),
            &invite.signature,
            &acceptance.0,
        ))?)))
    }

    /// Explicit approval of one device by the person authority. The consumer also
    /// checks the enrolled device's possession of its own TLS identity.
    pub fn enroll(
        &self,
        relationship: Uuid,
        device: PeerId,
        now: u64,
    ) -> Result<DeviceEnrollment, TransferError> {
        let mut grant = DeviceEnrollment {
            person: self.id(),
            device,
            relationship,
            issued: now,
            expires: now.checked_add(TTL).ok_or(ErrorCode::InvalidRequest)?,
            signature: String::new(),
        };
        grant.signature = self.sign(&canonical(("aerift/friends/enroll/1", grant.body()))?);
        Ok(grant)
    }
}

impl FriendRecord {
    pub fn verify(
        invite: &FriendInvitation,
        acceptance: &FriendAcceptance,
        approval: &FriendApproval,
        me: PersonId,
        local_device: PeerId,
        authenticated_remote: PeerId,
        now: u64,
    ) -> Result<Self, TransferError> {
        invite.verify(now)?;
        acceptance.verify(invite)?;
        verify(
            invite.issuer,
            &canonical((
                "aerift/friends/confirm/1",
                invite.body(),
                &invite.signature,
                &acceptance.0,
            ))?,
            &approval.0,
        )?;
        let (bound_local, person, primary) = match me {
            person if person == invite.issuer => (
                invite.issuer_device,
                invite.recipient,
                invite.recipient_device,
            ),
            person if person == invite.recipient => {
                (invite.recipient_device, invite.issuer, invite.issuer_device)
            }
            _ => return Err(ErrorCode::PeerUntrusted.into()),
        };
        if bound_local != local_device || primary != authenticated_remote {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        Ok(Self {
            person,
            owner: me,
            primary,
            nonce: invite.nonce,
            expires: invite.expires,
        })
    }
    pub fn relationship(&self) -> Uuid {
        self.nonce
    }
    pub fn person(&self) -> PersonId {
        self.person
    }
}
