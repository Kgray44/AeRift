//! Protected Windows Remote folder admission storage; the host retains the profile lock.
use std::path::Path;

use aerift_transfer::{folder::admission_store::ProtectedAdmissionStorage, TransferError};

use crate::{protected_store::ProtectedFile, windows_storage::storage_failed};

const STORE_NAME: &str = "remote-typed-folder-admission-v1.dpapi";

pub(super) struct RemoteFolderProfile(ProtectedFile);

impl ProtectedAdmissionStorage for RemoteFolderProfile {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        self.0.load().map_err(storage_failed)
    }

    fn replace_write_through(&self, bytes: &[u8]) -> Result<(), TransferError> {
        self.0.replace_write_through(bytes).map_err(storage_failed)
    }
}

/// Host must keep its existing exclusive profile lock while using this store.
/// Do not open a second store for the same profile in parallel.
pub(super) fn open_locked_profile(path: &Path) -> RemoteFolderProfile {
    RemoteFolderProfile(ProtectedFile::new(path, STORE_NAME))
}

#[test]
fn windows_dpapi_remote_folder_records_survive_store_reconstruction() {
    use aerift_transfer::{
        ambient::{freeze, Candidate, CaptureContext, CaptureLimits},
        folder::admission_store::FolderAdmissionStore,
        folder::{
            admission::{AdmittedFolder, FolderCapability, FolderRepresentation},
            prepare_folder,
        },
        ErrorCode, PeerId,
    };
    use std::{fs, sync::Arc};
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let _lock = crate::windows_storage::lock_profile(root).unwrap();
    let input = root.join("fixture");
    fs::create_dir(&input).unwrap();
    fs::write(input.join("test.bin"), b"private synthetic payload").unwrap();
    let capture = freeze(
        CaptureContext {
            explicit_selection: vec![Candidate::path(input)],
            ..Default::default()
        },
        CaptureLimits::default(),
    )
    .unwrap();
    let source = prepare_folder(Arc::new(capture), &CancellationToken::new()).unwrap();
    let capability = FolderCapability {
        representation: FolderRepresentation::FolderManifestV1,
        maximum_envelope_bytes: 1024 * 1024,
    };
    let sender = PeerId::from_tls_leaf(b"synthetic sender");
    let target = PeerId::from_tls_leaf(b"synthetic receiver");
    let id = Uuid::new_v4();
    let offer = |binding| {
        let body = source
            .encode_typed_offer(&capability, id, sender, target, binding)
            .unwrap();
        AdmittedFolder::from_remote_control(&body, Some(&capability), sender, target, binding)
            .unwrap()
    };
    let trust = CancellationToken::new();
    {
        let store = FolderAdmissionStore::new(open_locked_profile(root));
        store.remember(&offer([1; 32]), &trust).unwrap();
    }
    let ciphertext = fs::read(root.join(STORE_NAME)).unwrap();
    assert!(!ciphertext
        .windows(21)
        .any(|window| window == b"remote_typed_folder\x22,"));
    let reconstructed = FolderAdmissionStore::new(open_locked_profile(root));
    reconstructed.require_same(&offer([2; 32]), &trust).unwrap();
    ProtectedFile::new(root, STORE_NAME)
        .replace(br#"{"version":1,"scope":"nearby","admitted":[]}"#)
        .unwrap();
    assert_eq!(
        reconstructed
            .require_same(&offer([2; 32]), &trust)
            .unwrap_err()
            .code,
        ErrorCode::StorageFailed,
    );
}
