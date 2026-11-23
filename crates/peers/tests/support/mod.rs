use aerift_peers::{Device, SecretStore, TrustStore};
use aerift_transfer::{ErrorCode, PeerId, TransferError};
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Default)]
pub struct Store {
    identity: Mutex<Option<Vec<u8>>>,
    trusted: Mutex<HashMap<PeerId, Device>>,
    pub reject_trust_writes: AtomicBool,
}

impl SecretStore for Store {
    fn load(&self) -> Result<Option<Vec<u8>>, TransferError> {
        Ok(self.identity.lock().unwrap().clone())
    }

    fn initialize(&self, candidate: &[u8]) -> Result<Vec<u8>, TransferError> {
        Ok(self
            .identity
            .lock()
            .unwrap()
            .get_or_insert_with(|| candidate.to_vec())
            .clone())
    }
}

impl TrustStore for Store {
    fn load(&self) -> Result<Vec<Device>, TransferError> {
        Ok(self.trusted.lock().unwrap().values().cloned().collect())
    }

    fn put(&self, device: &Device) -> Result<(), TransferError> {
        if self.reject_trust_writes.load(Ordering::Relaxed) {
            return Err(ErrorCode::StorageFailed.into());
        }
        self.trusted
            .lock()
            .unwrap()
            .insert(device.id, device.clone());
        Ok(())
    }

    fn remove(&self, peer: PeerId) -> Result<(), TransferError> {
        self.trusted.lock().unwrap().remove(&peer);
        Ok(())
    }
}
