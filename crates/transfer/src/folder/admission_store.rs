//! Persistence for the Remote typed-offer admission, never user consent.
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{ErrorCode, PeerId, TransferError, TransferKey};

use super::admission::AdmittedFolder;

const CAPACITY: usize = 1024;
const MAX_ENCODED: usize = 256 * 1024;

/// Native profile supplies one protected instance behind its exclusive profile
/// ownership guard. Values are typed-offer commitments only, not remote paths,
/// destination authority, file contents, session keys, or acceptance.
pub trait ProtectedAdmissionStorage: Send + Sync {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError>;
    fn replace_write_through(&self, content: &[u8]) -> Result<(), TransferError>;
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u8,
    scope: Scope,
    admitted: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Scope {
    RemoteTypedFolder,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    peer: PeerId,
    id: Uuid,
    commitment: [u8; 32],
}

pub struct FolderAdmissionStore<S> {
    storage: S,
    guard: Mutex<()>,
}

impl<S: ProtectedAdmissionStorage> FolderAdmissionStore<S> {
    pub fn new(storage: S) -> Self {
        Self {
            storage,
            guard: Mutex::new(()),
        }
    }

    /// The dispatcher calls this only after verifying Remote mTLS, lane and
    /// current-session binding. Persist before showing metadata for approval.
    /// Same immutable commitment is idempotent across process restarts.
    pub fn remember(
        &self,
        offer: &AdmittedFolder,
        live_remote_trust: &CancellationToken,
    ) -> Result<(), TransferError> {
        if live_remote_trust.is_cancelled() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        let _lock = self.guard.lock().map_err(|_| ErrorCode::StorageFailed)?;
        let mut document = self.read()?;
        let key = offer.key();
        if let Some(previous) = lookup(&document, key) {
            return if previous.commitment == offer.commitment() {
                Ok(())
            } else {
                Err(ErrorCode::Conflict.into())
            };
        }
        if document.admitted.len() >= CAPACITY {
            return Err(ErrorCode::StorageFailed.into());
        }
        if live_remote_trust.is_cancelled() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        document.admitted.push(Entry {
            peer: key.peer,
            id: key.id,
            commitment: offer.commitment(),
        });
        document
            .admitted
            .sort_by_key(|entry| (entry.peer.to_string(), entry.id));
        let content = serde_json::to_vec(&document).map_err(|_| ErrorCode::StorageFailed)?;
        self.storage.replace_write_through(&content)
    }

    /// Protected storage permits recovering an immutable description, not a
    /// user's prior acceptance. Destination capabilities and authorizations
    /// must be reacquired natively, and same-session revocation remains live.
    pub fn require_same(
        &self,
        offer: &AdmittedFolder,
        live_remote_trust: &CancellationToken,
    ) -> Result<(), TransferError> {
        if live_remote_trust.is_cancelled() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        let _lock = self.guard.lock().map_err(|_| ErrorCode::StorageFailed)?;
        let document = self.read()?;
        if lookup(&document, offer.key()).is_none_or(|entry| entry.commitment != offer.commitment())
        {
            return Err(ErrorCode::Conflict.into());
        }
        Ok(())
    }

    fn read(&self) -> Result<Document, TransferError> {
        let Some(bytes) = self.storage.load()? else {
            return Ok(Document {
                version: 1,
                scope: Scope::RemoteTypedFolder,
                admitted: Vec::new(),
            });
        };
        if bytes.len() > MAX_ENCODED {
            return Err(ErrorCode::StorageFailed.into());
        }
        let document: Document =
            serde_json::from_slice(&bytes).map_err(|_| ErrorCode::StorageFailed)?;
        let mut seen = std::collections::HashSet::new();
        if document.version != 1
            || document.admitted.len() > CAPACITY
            || !document.admitted.iter().all(|item| {
                item.id.get_version() == Some(uuid::Version::Random)
                    && item.id.get_variant() == uuid::Variant::RFC4122
                    && item.commitment != [0; 32]
                    && seen.insert((item.peer, item.id))
            })
        {
            return Err(ErrorCode::StorageFailed.into());
        }
        Ok(document)
    }
}

fn lookup(document: &Document, key: TransferKey) -> Option<&Entry> {
    document
        .admitted
        .iter()
        .find(|item| item.peer == key.peer && item.id == key.id)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, sync::Arc};

    use super::*;
    use crate::{
        ambient::{Candidate, CaptureContext, CaptureLimits, freeze},
        folder::{
            MAX_BYTES,
            admission::{FolderCapability, FolderRepresentation},
            prepare_folder,
        },
    };

    struct FixtureFile(PathBuf);

    impl ProtectedAdmissionStorage for FixtureFile {
        fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
            match fs::read(&self.0) {
                Ok(data) => Ok(Some(data)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(_) => Err(ErrorCode::StorageFailed.into()),
            }
        }
        fn replace_write_through(&self, content: &[u8]) -> Result<(), TransferError> {
            fs::write(&self.0, content).map_err(|_| ErrorCode::StorageFailed.into())
        }
    }

    #[test]
    fn reconstructed_store_rejects_rewritten_metadata_and_does_not_persist_consent() {
        let fixture = tempfile::tempdir().unwrap();
        let record_path = fixture.path().join("synthetic-store");
        let source = fixture.path().join("Tree");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("file.txt"), b"private contents").unwrap();
        let capture = || {
            freeze(
                CaptureContext {
                    explicit_selection: vec![Candidate::path(source.clone())],
                    ..Default::default()
                },
                CaptureLimits::default(),
            )
            .unwrap()
        };
        let original = prepare_folder(Arc::new(capture()), &CancellationToken::new()).unwrap();
        let capability = FolderCapability {
            representation: FolderRepresentation::FolderManifestV1,
            maximum_envelope_bytes: MAX_BYTES,
        };
        let sender = PeerId::from_tls_leaf(b"synthetic stable sender");
        let recipient = PeerId::from_tls_leaf(b"synthetic stable recipient");
        let id = Uuid::new_v4();
        let parse = |folder: &crate::folder::PreparedFolder, bind: [u8; 32]| {
            let encoded = folder
                .encode_typed_offer(&capability, id, sender, recipient, bind)
                .unwrap();
            AdmittedFolder::from_remote_control(
                &encoded,
                Some(&capability),
                sender,
                recipient,
                bind,
            )
            .unwrap()
        };
        let trust = CancellationToken::new();
        let first = FolderAdmissionStore::new(FixtureFile(record_path.clone()));
        first.remember(&parse(&original, [1; 32]), &trust).unwrap();
        drop(first);

        let second = FolderAdmissionStore::new(FixtureFile(record_path.clone()));
        let retry = parse(&original, [2; 32]);
        second.require_same(&retry, &trust).unwrap();
        second.remember(&retry, &trust).unwrap();
        let stored = fs::read(&record_path).unwrap();
        let stored = std::str::from_utf8(&stored).unwrap();
        for private_value in [
            "file.txt",
            "private contents",
            "destination",
            "accepted",
            "channelBinding",
        ] {
            assert!(!stored.contains(private_value));
        }

        fs::write(source.join("file.txt"), b"modified bytes").unwrap();
        let changed = prepare_folder(Arc::new(capture()), &CancellationToken::new()).unwrap();
        let tampered = parse(&changed, [2; 32]);
        assert_eq!(
            second.remember(&tampered, &trust).unwrap_err().code,
            ErrorCode::Conflict
        );
        trust.cancel();
        assert_eq!(
            second.require_same(&retry, &trust).unwrap_err().code,
            ErrorCode::PeerUntrusted
        );
        fs::write(
            &record_path,
            br#"{"version":1,"scope":"nearby","admitted":[]}"#,
        )
        .unwrap();
        assert_eq!(
            second
                .require_same(&retry, &CancellationToken::new())
                .unwrap_err()
                .code,
            ErrorCode::StorageFailed
        );
    }
}
