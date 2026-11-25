//! Device-signed transport hint; never a Remote grant or operator configuration.
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aerift_transfer::{ErrorCode, PeerId, TransferError};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{ECDSA_P256_SHA256_ASN1, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use tokio_rustls::rustls::pki_types::CertificateDer;
use x509_parser::prelude::parse_x509_certificate;

use crate::{
    Identity, InvitationCode, identity::profile, pairing::INVITATION_TTL, remote::parse_invitation,
};

const PREFIX: &str = "aerift-wan:v1:";
const DOMAIN: &[u8] = b"AeRift Remote WAN device invitation v1\0";
const MAX_CODE: usize = 8192;
const MAX_CERT: usize = 4096;
const MAX_BODY: usize = 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    target: PeerId,
    issuer_outer: [u8; 32],
    target_outer: [u8; 32],
    expires_at: u64,
    code: String,
}

/// Signature-checked, time-limited candidate route metadata, not pairing
/// consent. Only the original Remote issuer may approve or reject the request.
pub struct WanInvitationBinding {
    issuer: PeerId,
    target: PeerId,
    issuer_outer: [u8; 32],
    target_outer: [u8; 32],
    expires_at: SystemTime,
    pub(crate) code: String,
}
impl WanInvitationBinding {
    pub fn issuer(&self) -> PeerId {
        self.issuer
    }
    pub fn recipient(&self) -> PeerId {
        self.target
    }
    pub fn issuer_endpoint_key(&self) -> [u8; 32] {
        self.issuer_outer
    }
    pub fn recipient_endpoint_key(&self) -> [u8; 32] {
        self.target_outer
    }
    pub fn expires_at(&self) -> SystemTime {
        self.expires_at
    }
}

pub(crate) fn transcript(body: &[u8]) -> Vec<u8> {
    [DOMAIN, body].concat()
}

pub(crate) fn verify_distinct_keys(local: [u8; 32], remote: [u8; 32]) -> Result<(), TransferError> {
    if local == remote || local == [0; 32] || remote == [0; 32] {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(())
}

pub(crate) fn seal(
    identity: &Identity,
    target: PeerId,
    issuer_outer: [u8; 32],
    target_outer: [u8; 32],
    invitation: InvitationCode,
) -> Result<String, TransferError> {
    let expires_at = invitation
        .expires_at
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ErrorCode::InternalError)?
        .as_secs();
    let body = serde_json::to_vec(&Body {
        target,
        issuer_outer,
        target_outer,
        expires_at,
        code: invitation.code,
    })
    .map_err(|_| ErrorCode::InternalError)?;
    if body.len() > MAX_BODY || identity.certificate_der().len() > MAX_CERT {
        return Err(ErrorCode::InternalError.into());
    }
    let signature = identity.sign_wan_invitation(&body)?;
    Ok(format!(
        "{PREFIX}{}.{}.{}",
        URL_SAFE_NO_PAD.encode(identity.certificate_der()),
        URL_SAFE_NO_PAD.encode(body),
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

pub(crate) fn inspect_at(
    code: &str,
    expected_issuer: PeerId,
    target: PeerId,
    target_outer: [u8; 32],
    now: SystemTime,
) -> Result<WanInvitationBinding, TransferError> {
    let invalid = || ErrorCode::InvalidRequest;
    if code.len() > MAX_CODE || expected_issuer == target {
        return Err(invalid().into());
    }
    let (leaf, rest) = code
        .strip_prefix(PREFIX)
        .and_then(|code| code.split_once('.'))
        .ok_or_else(invalid)?;
    let (body, signature) = rest.split_once('.').ok_or_else(invalid)?;
    let decode = |value: &str, max: usize| {
        if value.len() > max.saturating_mul(4).div_ceil(3) {
            return Err(invalid());
        }
        URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| invalid())
            .and_then(|bytes| {
                if bytes.len() <= max {
                    Ok(bytes)
                } else {
                    Err(invalid())
                }
            })
    };
    let leaf = CertificateDer::from(decode(leaf, MAX_CERT)?);
    let body = decode(body, MAX_BODY)?;
    let signature = decode(signature, 72)?;
    profile(&leaf, &[]).map_err(|_| ErrorCode::PeerUntrusted)?;
    let (_, parsed) =
        parse_x509_certificate(leaf.as_ref()).map_err(|_| ErrorCode::PeerUntrusted)?;
    UnparsedPublicKey::new(
        &ECDSA_P256_SHA256_ASN1,
        &parsed.public_key().subject_public_key.data,
    )
    .verify(&transcript(&body), &signature)
    .map_err(|_| ErrorCode::PeerUntrusted)?;
    // Require both proof of possession and the out-of-band leaf pin.
    if PeerId::from_tls_leaf(leaf.as_ref()) != expected_issuer {
        return Err(ErrorCode::PeerUntrusted.into());
    }
    let body: Body = serde_json::from_slice(&body).map_err(|_| invalid())?;
    let expires_at = UNIX_EPOCH
        .checked_add(Duration::from_secs(body.expires_at))
        .ok_or_else(invalid)?;
    if expires_at <= now || expires_at.duration_since(now).map_err(|_| invalid())? > INVITATION_TTL
    {
        return Err(ErrorCode::PairingExpired.into());
    }
    if body.target != target
        || body.target_outer != target_outer
        || parse_invitation(&body.code)?.peer != expected_issuer
    {
        return Err(ErrorCode::PeerUntrusted.into());
    }
    verify_distinct_keys(body.issuer_outer, target_outer)?;
    Ok(WanInvitationBinding {
        issuer: expected_issuer,
        target,
        issuer_outer: body.issuer_outer,
        target_outer,
        expires_at,
        code: body.code,
    })
}
