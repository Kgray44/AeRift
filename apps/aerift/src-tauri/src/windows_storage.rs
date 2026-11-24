use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use aerift_peers::{Device, FriendAuthority, FriendBook, FriendStore, SecretStore, TrustStore};
use aerift_transfer::{ErrorCode, PeerId, TransferError};

use crate::protected_store::ProtectedFile;

pub(crate) fn lock_profile(directory: &Path) -> Result<File, TransferError> {
    fs::create_dir_all(directory).map_err(storage_failed)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(directory.join("session.lock"))
        .map_err(storage_failed)?;
    lock.try_lock().map_err(|_| ErrorCode::Conflict)?;
    Ok(lock)
}

pub(crate) struct WindowsIdentity(ProtectedFile);

impl WindowsIdentity {
    pub(crate) fn new(directory: &Path) -> Self {
        Self(ProtectedFile::new(directory, "identity.dpapi"))
    }
}

impl SecretStore for WindowsIdentity {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        self.0.load().map_err(storage_failed)
    }

    fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError> {
        if self.0.create_if_absent(candidate).map_err(storage_failed)? {
            return Ok(candidate.to_vec());
        }
        self.load()?.ok_or_else(|| ErrorCode::StorageFailed.into())
    }
}

pub(crate) struct WindowsTrust {
    file: ProtectedFile,
    lock: Mutex<()>,
}

impl WindowsTrust {
    pub(crate) fn new(directory: &Path) -> Self {
        Self {
            file: ProtectedFile::new(directory, "trust.dpapi"),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<Vec<Device>, TransferError> {
        self.file
            .load()
            .map_err(storage_failed)?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(storage_failed))
            .transpose()
            .map(Option::unwrap_or_default)
    }

    fn update(&self, change: impl FnOnce(&mut Vec<Device>)) -> Result<(), TransferError> {
        let _guard = self.lock.lock().map_err(storage_failed)?;
        let mut devices = self.read()?;
        change(&mut devices);
        let bytes = serde_json::to_vec(&devices).map_err(storage_failed)?;
        self.file.replace(&bytes).map_err(storage_failed)
    }
}

impl TrustStore for WindowsTrust {
    fn load(&self) -> Result<Vec<Device>, TransferError> {
        let _guard = self.lock.lock().map_err(storage_failed)?;
        self.read()
    }

    fn put(&self, device: &Device) -> Result<(), TransferError> {
        self.update(|devices| {
            if let Some(existing) = devices.iter_mut().find(|existing| existing.id == device.id) {
                *existing = device.clone();
            } else {
                devices.push(device.clone());
            }
        })
    }

    fn remove(&self, peer: PeerId) -> Result<(), TransferError> {
        self.update(|devices| devices.retain(|device| device.id != peer))
    }
}

pub(crate) struct ReceiveFolder(ProtectedFile);

impl ReceiveFolder {
    pub(crate) fn new(directory: &Path) -> Self {
        Self(ProtectedFile::new(directory, "receive-folder.dpapi"))
    }

    pub(crate) fn load(&self) -> Result<Option<PathBuf>, TransferError> {
        self.0
            .load()
            .map_err(storage_failed)?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(storage_failed))
            .transpose()
    }
    pub(crate) fn save(&self, path: &Path) -> Result<(), TransferError> {
        let bytes = serde_json::to_vec(path).map_err(storage_failed)?;
        self.0.replace(&bytes).map_err(storage_failed)
    }
}

pub(crate) fn storage_failed(_: impl Sized) -> TransferError {
    ErrorCode::StorageFailed.into()
}

/// Open the protected Friends book without starting listeners.
pub(crate) fn open_friends(
    directory: &Path,
) -> Result<(FriendAuthority, Arc<FriendBook>), TransferError> {
    let profile = directory.join("friends-v1");
    let store = Arc::new(WindowsFriendStore::new(&profile)?);
    let identity = WindowsIdentity(ProtectedFile::new(&profile, "person.dpapi"));
    if store.load()?.is_some() && identity.load()?.is_none() {
        return Err(ErrorCode::StorageFailed.into());
    }
    let authority = FriendAuthority::load_or_create(&identity)?;
    let book = Arc::new(FriendBook::open(authority.id(), store)?);
    Ok((authority, book))
}

/// Keep the OS-held lock alive until every reference to the book is dropped.
struct WindowsFriendStore {
    _profile_lock: File,
    ledger: ProtectedFile,
    transaction: Mutex<()>,
}

impl WindowsFriendStore {
    fn new(profile: &Path) -> Result<Self, TransferError> {
        Ok(Self {
            _profile_lock: lock_profile(profile)?,
            ledger: ProtectedFile::new(profile, "book.dpapi"),
            transaction: Mutex::new(()),
        })
    }
}

impl FriendStore for WindowsFriendStore {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        let _guard = self.transaction.lock().map_err(storage_failed)?;
        self.ledger.load().map_err(storage_failed)
    }
    fn replace(&self, expected: Option<&[u8]>, data: &[u8]) -> Result<(), TransferError> {
        let _guard = self.transaction.lock().map_err(storage_failed)?;
        if self.ledger.load().map_err(storage_failed)?.as_deref() != expected {
            return Err(ErrorCode::Conflict.into());
        }
        self.ledger
            .replace_write_through(data)
            .map_err(storage_failed)
    }
}

#[cfg(test)]
mod friends_tests {
    use super::*;
    use aerift_peers::{FriendClaim, FriendRecord};

    #[test]
    fn friend_award_survives_profile_reopen_and_does_not_share_local_trust() {
        let dir = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        let (authority, book) = open_friends(dir.path()).unwrap();
        let (remote_authority, _remote_book) = open_friends(remote.path()).unwrap();
        assert!(
            open_friends(dir.path()).is_err(),
            "one process owns a sender profile"
        );
        let a = PeerId::from_tls_leaf(b"synthetic-a");
        let b = PeerId::from_tls_leaf(b"synthetic-b");
        let other = PeerId::from_tls_leaf(b"synthetic-other");
        let invite = authority.invite(a, remote_authority.id(), b, 10).unwrap();
        let accept = remote_authority.accept(&invite, a, b, 11).unwrap();
        let approval = authority.confirm(&invite, &accept, b, 12).unwrap();
        let record =
            FriendRecord::verify(&invite, &accept, &approval, authority.id(), a, b, 13).unwrap();
        let relationship = record.relationship();
        book.add(record, 13).unwrap();
        book.enroll(
            remote_authority.enroll(relationship, other, 14).unwrap(),
            other,
            15,
        )
        .unwrap();
        let offer = uuid::Uuid::new_v4();
        book.offer(offer, remote_authority.id(), None, [16; 32])
            .unwrap();
        assert_eq!(
            book.claim(offer, b, [16; 32]).unwrap(),
            FriendClaim::Awarded
        );
        book.begin_payload(offer, b, [16; 32]).unwrap();
        assert!(TrustStore::load(&WindowsTrust::new(dir.path()))
            .unwrap()
            .is_empty());
        assert!(SecretStore::load(&WindowsIdentity::new(dir.path()))
            .unwrap()
            .is_none());
        let original = authority.id();
        drop(book);
        drop(authority);
        let (authority, book) = open_friends(dir.path()).unwrap();
        assert_eq!(authority.id(), original);
        assert_eq!(book.winner(offer).unwrap(), Some(b));
        assert!(book.claim(offer, other, [16; 32]).is_err());
        assert!(book.begin_payload(offer, b, [16; 32]).is_err());
        drop(book);
        let profile = dir.path().join("friends-v1");
        let stored = fs::read(profile.join("book.dpapi")).unwrap();
        let offer_string = offer.to_string();
        assert!(!stored
            .windows(offer_string.len())
            .any(|part| part == offer_string.as_bytes()));
        fs::remove_file(profile.join("person.dpapi")).unwrap();
        assert!(
            open_friends(dir.path()).is_err(),
            "never replace a missing authority for an existing ledger"
        );
    }

    #[test]
    fn compare_and_swap_does_not_commit_a_stale_snapshot() {
        let profile = tempfile::tempdir().unwrap();
        let store = WindowsFriendStore::new(profile.path()).unwrap();
        assert_eq!(store.load().unwrap(), None);
        store.replace(None, b"original").unwrap();
        let stale = store.load().unwrap();
        store.replace(stale.as_deref(), b"winner").unwrap();
        assert_eq!(
            store.replace(stale.as_deref(), b"loser").unwrap_err().code,
            ErrorCode::Conflict
        );
        assert_eq!(store.load().unwrap().as_deref(), Some(b"winner".as_slice()));
    }
}

#[cfg(test)]
#[path = "windows_storage/friends_qualification.rs"]
mod friends_qualification;
