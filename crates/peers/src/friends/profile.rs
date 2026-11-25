//! Explicitly shared person profiles. Local aliases and private photo sources
//! are never represented by this contract.
use aerift_transfer::{ErrorCode, PeerId, TransferError};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    FriendAuthority, FriendBook, PersonId,
    authority::{canonical, verify},
};

const DOMAIN: &str = "aerift/friends/profile/1";
const TTL: u64 = 600;
const MAX_WIRE: usize = 18_000;
const MAX_NAME: usize = 128;
const MAX_REVISION: u64 = (1 << 53) - 1;
pub const FRIEND_PROFILE_RGB_EDGE: usize = 64;
const RGB_BYTES: usize = FRIEND_PROFILE_RGB_EDGE * FRIEND_PROFILE_RGB_EDGE * 3;

/// Built-in designs, not URLs, arbitrary CSS, or remote fetch directives.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FriendGlassPreset {
    Glacier,
    Prism,
    Aurora,
    Obsidian,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FriendProfileAvatar {
    Initials,
    Solid {
        rgb: [u8; 3],
    },
    Glass {
        preset: FriendGlassPreset,
    },
    /// Exactly 64x64 RGB24 in row-major order. A host must downsample a
    /// deliberately selected image and strip alpha and metadata before sharing.
    Rgb64 {
        pixels: String,
    },
}

impl FriendProfileAvatar {
    pub fn from_rgb64(pixels: &[u8]) -> Result<Self, TransferError> {
        if pixels.len() != RGB_BYTES {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(Self::Rgb64 {
            pixels: URL_SAFE_NO_PAD.encode(pixels),
        })
    }

    pub fn rgb64_pixels(&self) -> Result<Option<Vec<u8>>, TransferError> {
        let Self::Rgb64 { pixels } = self else {
            return Ok(None);
        };
        if pixels.len() != RGB_BYTES * 4 / 3 {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let raw = URL_SAFE_NO_PAD
            .decode(pixels)
            .map_err(|_| ErrorCode::InvalidRequest)?;
        if raw.len() != RGB_BYTES {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(Some(raw))
    }
}

/// Only the owner's intentionally published fields. Nickname should be
/// omitted unless separately selected for sharing; default it to None.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedFriendProfile {
    display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nickname: Option<String>,
    avatar: FriendProfileAvatar,
}

impl SharedFriendProfile {
    pub fn new(
        display_name: &str,
        nickname: Option<&str>,
        avatar: FriendProfileAvatar,
    ) -> Result<Self, TransferError> {
        let profile = Self {
            display_name: display_name.trim().into(),
            nickname: nickname.map(|value| value.trim().into()),
            avatar,
        };
        profile.validate()?;
        Ok(profile)
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn nickname(&self) -> Option<&str> {
        self.nickname.as_deref()
    }
    pub fn avatar(&self) -> &FriendProfileAvatar {
        &self.avatar
    }

    pub(super) fn validate(&self) -> Result<(), TransferError> {
        fn safe_label(value: &str) -> bool {
            !value.is_empty()
                && value.len() <= MAX_NAME
                && value.trim() == value
                && !value.chars().any(|c| {
                    c.is_control()
                        || matches!(c,
                    '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{2028}' | '\u{2029}' |
                    '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                })
        }
        if !safe_label(&self.display_name)
            || self.nickname.as_deref().is_some_and(|v| !safe_label(v))
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        self.avatar.rgb64_pixels()?;
        Ok(())
    }
}

/// Persist with the last accepted presentation in protected native state,
/// and supply it for every subsequent receive. Not an authority grant.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FriendProfileCursor {
    pub(super) issuer: PersonId,
    pub(super) recipient: PersonId,
    pub(super) relationship: Uuid,
    pub(super) revision: u64,
}

impl FriendProfileCursor {
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub(super) fn version_valid(&self) -> bool {
        (1..=MAX_REVISION).contains(&self.revision)
    }
}

pub struct VerifiedFriendProfile {
    pub cursor: FriendProfileCursor,
    pub profile: SharedFriendProfile,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    cursor: FriendProfileCursor,
    sender_device: PeerId,
    recipient_device: PeerId,
    issued: u64,
    expires: u64,
    profile: SharedFriendProfile,
    signature: String,
}

impl Envelope {
    fn signed_bytes(&self) -> Result<Vec<u8>, TransferError> {
        canonical((
            DOMAIN,
            self.cursor,
            self.sender_device,
            self.recipient_device,
            self.issued,
            self.expires,
            &self.profile,
        ))
    }
}

impl FriendAuthority {
    /// Call only after deliberate owner approval of these exact shared fields.
    /// Local and remote device IDs come from the live pinned mTLS transport
    /// and native profile, never an invitation form or webview request.
    pub fn share_profile(
        &self,
        book: &FriendBook,
        own_device: PeerId,
        recipient: PersonId,
        authenticated_recipient: PeerId,
        revision: u64,
        now: u64,
        profile: SharedFriendProfile,
        confirmed: bool,
    ) -> Result<Vec<u8>, TransferError> {
        if !confirmed || self.id() != book.profile_owner() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        profile.validate()?;
        if !(1..=MAX_REVISION).contains(&revision) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let relationship = book.profile_relationship(recipient, authenticated_recipient)?;
        let mut envelope = Envelope {
            cursor: FriendProfileCursor {
                issuer: self.id(),
                recipient,
                relationship,
                revision,
            },
            sender_device: own_device,
            recipient_device: authenticated_recipient,
            issued: now,
            expires: now.checked_add(TTL).ok_or(ErrorCode::InvalidRequest)?,
            profile,
            signature: String::new(),
        };
        envelope.signature = self.sign(&envelope.signed_bytes()?);
        let wire = canonical(envelope)?;
        if wire.len() > MAX_WIRE {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(wire)
    }
}

impl FriendBook {
    /// Requires verified friendship already committed on both ends. The host
    /// must persist the returned cursor and profile atomically and serialize
    /// compare-and-set publication against later updates/removal. Expiry
    /// authorizes accepting a packet, not ongoing visibility of cached data.
    pub fn verify_shared_profile(
        &self,
        wire: &[u8],
        self_device: PeerId,
        authenticated_sender: PeerId,
        now: u64,
        prior: Option<FriendProfileCursor>,
    ) -> Result<VerifiedFriendProfile, TransferError> {
        if wire.len() > MAX_WIRE {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let envelope: Envelope =
            serde_json::from_slice(wire).map_err(|_| ErrorCode::InvalidRequest)?;
        let cursor = envelope.cursor;
        if !(1..=MAX_REVISION).contains(&cursor.revision) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        if envelope.expires.checked_sub(envelope.issued) != Some(TTL)
            || !(envelope.issued..envelope.expires).contains(&now)
        {
            return Err(ErrorCode::PairingExpired.into());
        }
        if self.profile_owner() != cursor.recipient
            || envelope.recipient_device != self_device
            || envelope.sender_device != authenticated_sender
            || self.profile_relationship(cursor.issuer, authenticated_sender)?
                != cursor.relationship
        {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        verify(
            cursor.issuer,
            &envelope.signed_bytes()?,
            &envelope.signature,
        )?;
        if prior.is_some_and(|prior| {
            prior.relationship != cursor.relationship
                || prior.issuer != cursor.issuer
                || prior.recipient != cursor.recipient
                || prior.revision >= cursor.revision
        }) {
            return Err(ErrorCode::Conflict.into());
        }
        envelope.profile.validate()?;
        Ok(VerifiedFriendProfile {
            cursor,
            profile: envelope.profile,
        })
    }
}
