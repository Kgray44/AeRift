//! Typed Remote folder control records. No transport route is registered here.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{MAX_BYTES, MAX_ENTRIES, NAME, PreparedFolder, valid_digest};
use crate::{ErrorCode, Offer, PeerId, TransferError, TransferKey, model::safe_name};

const LABEL: &[u8] = b"aerift/remote/folder-offer/v1\0";
const CONTROL_LIMIT: usize = 2048;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderRepresentation {
    FolderManifestV1,
}

/// Typed capability advertisement is distinct from legacy file readiness.
/// An authenticated host may advertise only if it has safe native publication.
#[derive(Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FolderCapability {
    pub representation: FolderRepresentation,
    pub maximum_envelope_bytes: u64,
}

#[derive(Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FolderOffer {
    representation: FolderRepresentation,
    sender: PeerId,
    recipient: PeerId,
    envelope: Offer,
    root_title: String,
    entries: u32,
    manifest_sha256: String,
    channel_binding: [u8; 32],
}

/// Read-only native proof of typed admission, for persisting along the receipt.
/// Successful verification is not user consent, nor is it file acceptance.
#[derive(Debug)]
pub struct AdmittedFolder {
    offer: FolderOffer,
    commitment: [u8; 32],
}

impl PreparedFolder {
    /// Use only over the authenticated Remote control exchange. The supplied
    /// binding comes from the connection, never from the peer's request body.
    pub fn encode_typed_offer(
        &self,
        capability: &FolderCapability,
        id: Uuid,
        sender: PeerId,
        recipient: PeerId,
        channel_binding: [u8; 32],
    ) -> Result<Vec<u8>, TransferError> {
        if self.0.size > capability.checked_limit()? {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        let entries = self.0.capture.entries();
        let request = FolderOffer {
            representation: capability.representation,
            sender,
            recipient,
            envelope: self.offer(id)?,
            root_title: entries[0].manifest().title.clone(),
            entries: entries.len() as u32,
            manifest_sha256: format!("{:x}", Sha256::digest(&self.0.header)),
            channel_binding,
        };
        request.validate_shape()?;
        let data = serde_json::to_vec(&request).map_err(|_| ErrorCode::InvalidRequest)?;
        if data.len() > CONTROL_LIMIT {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(data)
    }
}

impl FolderCapability {
    fn checked_limit(&self) -> Result<u64, TransferError> {
        if self.maximum_envelope_bytes == 0 || self.maximum_envelope_bytes > MAX_BYTES {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        Ok(self.maximum_envelope_bytes)
    }
}

impl FolderOffer {
    fn validate_shape(&self) -> Result<(), TransferError> {
        self.envelope.validate()?;
        if self.envelope.name != NAME
            || self.envelope.size_bytes == 0
            || self.sender == self.recipient
            || self.root_title.is_empty()
            || !self.root_title.is_ascii()
            || !safe_name(&self.root_title)
            || self.entries == 0
            || self.entries as usize > MAX_ENTRIES
            || !valid_digest(&self.manifest_sha256)
            || self.channel_binding == [0; 32]
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(())
    }
}

impl AdmittedFolder {
    /// Parse only in a future distinct Remote typed-offer endpoint. The caller
    /// supplies the already-authorized Remote mTLS sender and current binding.
    /// No flag, header, filename or raw JSON field can grant that authority.
    pub fn from_remote_control(
        bytes: &[u8],
        local_capability: Option<&FolderCapability>,
        authenticated_sender: PeerId,
        local_recipient: PeerId,
        channel_binding: [u8; 32],
    ) -> Result<Self, TransferError> {
        let capability = local_capability.ok_or(ErrorCode::UnsupportedVersion)?;
        let max = capability.checked_limit()?;
        if bytes.len() > CONTROL_LIMIT {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let offer: FolderOffer =
            serde_json::from_slice(bytes).map_err(|_| ErrorCode::InvalidRequest)?;
        offer.validate_shape()?;
        if offer.sender != authenticated_sender
            || offer.recipient != local_recipient
            || offer.channel_binding != channel_binding
        {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        if offer.representation != capability.representation || offer.envelope.size_bytes > max {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        let mut digest = Sha256::new();
        digest.update(LABEL);
        // Channel exporter is admission-only. The commitment must remain
        // stable for the same peer, UUID and description after reconnection.
        digest.update(offer.envelope.manifest_digest()?);
        digest.update(offer.sender.to_string().as_bytes());
        digest.update(offer.recipient.to_string().as_bytes());
        digest.update((offer.root_title.len() as u64).to_be_bytes());
        digest.update(offer.root_title.as_bytes());
        digest.update(offer.entries.to_be_bytes());
        digest.update(offer.manifest_sha256.as_bytes());
        Ok(Self {
            offer,
            commitment: digest.finalize().into(),
        })
    }

    pub fn key(&self) -> TransferKey {
        TransferKey {
            peer: self.offer.sender,
            id: self.offer.envelope.id,
        }
    }

    pub fn envelope(&self) -> &Offer {
        &self.offer.envelope
    }
    pub fn root_title(&self) -> &str {
        &self.offer.root_title
    }
    pub fn entries(&self) -> u32 {
        self.offer.entries
    }
    pub fn commitment(&self) -> [u8; 32] {
        self.commitment
    }

    /// Before exporting, re-check the verified envelope header and staged root
    /// metadata against the exact typed offer shown during user authorization.
    pub fn verify_object_metadata(
        &self,
        frame: &[u8],
        title: &str,
        entries: usize,
    ) -> Result<(), TransferError> {
        if title != self.offer.root_title
            || entries != self.offer.entries as usize
            || format!("{:x}", Sha256::digest(frame)) != self.offer.manifest_sha256
        {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::{
        ambient::{Candidate, CaptureContext, CaptureLimits, freeze},
        folder::prepare_folder,
    };

    #[test]
    fn typed_metadata_is_bound_to_scope_and_stable_on_authenticated_reconnect() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("synthetic");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("fixture.bin"), b"fixture").unwrap();
        let folder = prepare_folder(
            Arc::new(
                freeze(
                    CaptureContext {
                        explicit_selection: vec![Candidate::path(root)],
                        ..Default::default()
                    },
                    CaptureLimits::default(),
                )
                .unwrap(),
            ),
            &CancellationToken::new(),
        )
        .unwrap();
        let capability = FolderCapability {
            representation: FolderRepresentation::FolderManifestV1,
            maximum_envelope_bytes: MAX_BYTES,
        };
        let sender = PeerId::from_tls_leaf(b"sender");
        let recipient = PeerId::from_tls_leaf(b"recipient");
        let different = PeerId::from_tls_leaf(b"different");
        let id = Uuid::new_v4();
        let encoded = |binding| {
            folder
                .encode_typed_offer(&capability, id, sender, recipient, binding)
                .unwrap()
        };
        let bytes = encoded([1; 32]);
        let parse = |data: &[u8], origin, target, binding| {
            AdmittedFolder::from_remote_control(data, Some(&capability), origin, target, binding)
        };
        let first = parse(&bytes, sender, recipient, [1; 32]).unwrap();
        assert_eq!(first.key(), TransferKey { id, peer: sender });
        assert_eq!(first.root_title(), "synthetic");
        assert_eq!(first.entries(), 2);
        first
            .verify_object_metadata(&folder.0.header, "synthetic", 2)
            .unwrap();
        assert!(
            first
                .verify_object_metadata(&folder.0.header, "different", 2)
                .is_err()
        );
        assert!(
            first
                .verify_object_metadata(b"different", "synthetic", 2)
                .is_err()
        );
        assert!(parse(&bytes, sender, recipient, [2; 32]).is_err());
        assert!(parse(&bytes, different, recipient, [1; 32]).is_err());
        assert!(parse(&bytes, sender, different, [1; 32]).is_err());
        let retry = parse(&encoded([2; 32]), sender, recipient, [2; 32]).unwrap();
        assert_eq!(first.commitment(), retry.commitment());
        let mut changed: FolderOffer = serde_json::from_slice(&bytes).unwrap();
        changed.root_title = "modified".into();
        let changed = parse(
            &serde_json::to_vec(&changed).unwrap(),
            sender,
            recipient,
            [1; 32],
        )
        .unwrap();
        assert_ne!(changed.commitment(), first.commitment());
        assert!(
            parse(
                &serde_json::to_vec(first.envelope()).unwrap(),
                sender,
                recipient,
                [1; 32]
            )
            .is_err()
        );
        assert!(parse(&vec![b' '; CONTROL_LIMIT + 1], sender, recipient, [1; 32]).is_err());
        assert_eq!(
            AdmittedFolder::from_remote_control(&bytes, None, sender, recipient, [1; 32])
                .unwrap_err()
                .code,
            ErrorCode::UnsupportedVersion
        );
        let old = String::from_utf8(bytes)
            .unwrap()
            .replace("folder_manifest_v1", "unrecognized_v0");
        assert!(parse(old.as_bytes(), sender, recipient, [1; 32]).is_err());
    }
}
