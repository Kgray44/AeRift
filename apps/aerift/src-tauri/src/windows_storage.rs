use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::Mutex,
};

use aerift_peers::{Device, SecretStore, TrustStore};
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
