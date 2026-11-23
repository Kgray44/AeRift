use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use tempfile::NamedTempFile;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{ErrorCode, Offer, PeerId, State, Status, TransferError};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TransferKey {
    pub peer: PeerId,
    pub id: Uuid,
}

#[derive(Clone, Debug)]
pub struct IncomingTransfer {
    pub key: TransferKey,
    pub offer: Offer,
    pub status: Status,
    /// Native only. Expose an opaque result to the UI if it needs to open the file.
    pub saved_path: Option<PathBuf>,
}

pub struct Receiver {
    destination: PathBuf,
    limits: ReceiveLimits,
    entries: Mutex<HashMap<TransferKey, Entry>>,
    changes: watch::Sender<u64>,
}

#[derive(Clone, Copy, Debug)]
pub struct ReceiveLimits {
    /// Local byte budget for accepted and active transfers combined.
    pub active_bytes: u64,
    /// Includes terminal receipts, which are kept until shutdown.
    pub session_offers: usize,
}

struct Entry {
    transfer: IncomingTransfer,
    cancel: CancellationToken,
}

impl Receiver {
    /// The native host provides a private, receiver-owned directory.
    pub fn new(destination: &Path, limits: ReceiveLimits) -> Result<Self, TransferError> {
        let destination = destination.canonicalize().map_err(|_| ErrorCode::StorageFailed)?;
        if !destination.is_dir() {
            return Err(ErrorCode::StorageFailed.into());
        }
        let (changes, _) = watch::channel(0);
        Ok(Self { destination, limits, entries: Mutex::default(), changes })
    }

    /// Subscribe before enumerating transfers. A watch wakeup may represent multiple updates.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub fn snapshot(&self) -> Vec<IncomingTransfer> {
        self.entries().values().map(|entry| entry.transfer.clone()).collect()
    }

    pub fn respond(&self, key: TransferKey, accept: bool) -> Result<Status, TransferError> {
        let mut entries = self.entries();
        let active = entries.values()
            .filter(|entry| matches!(entry.transfer.status.state, State::Accepted | State::Transferring))
            .map(|entry| entry.transfer.offer.size_bytes)
            .fold(0u64, u64::saturating_add);
        let entry = Self::entry(&mut entries, key)?;
        if entry.transfer.status.state != State::Pending {
            return Err(ErrorCode::Conflict.into());
        }
        if accept && entry.transfer.offer.size_bytes > self.limits.active_bytes.saturating_sub(active) {
            entry.transfer.status = Status {
                state: State::Failed,
                bytes_transferred: 0,
                error: Some(ErrorCode::StorageFailed.into()),
            };
            self.changed();
            return Err(ErrorCode::StorageFailed.into());
        }
        entry.transfer.status.state = if accept { State::Accepted } else { State::Rejected };
        self.changed();
        Ok(entry.transfer.status)
    }

    pub fn cancel(&self, key: TransferKey) -> Result<Status, TransferError> {
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, key)?;
        if Self::cancel_entry(entry) {
            self.changed();
        }
        Ok(entry.transfer.status)
    }

    /// Call after removing trust to cancel the peer's offers and active streams.
    pub fn cancel_peer(&self, peer: PeerId) {
        let mut entries = self.entries();
        for (key, entry) in entries.iter_mut() {
            if key.peer == peer && Self::cancel_entry(entry) {
                self.changed();
            }
        }
    }

    pub fn status(&self, key: TransferKey) -> Result<Status, TransferError> {
        Ok(Self::entry(&mut self.entries(), key)?.transfer.status)
    }

    pub(crate) fn offer(&self, peer: PeerId, offer: Offer) -> Result<(bool, Status), TransferError> {
        offer.validate()?;
        let key = TransferKey { peer, id: offer.id };
        let mut entries = self.entries();
        if let Some(entry) = entries.get(&key) {
            if entry.transfer.offer == offer {
                return Ok((false, entry.transfer.status));
            }
            return Err(ErrorCode::Conflict.into());
        }
        if entries.len() >= self.limits.session_offers {
            return Err(ErrorCode::Conflict.into());
        }
        let status = Status::new(State::Pending);
        entries.insert(key, Entry {
            transfer: IncomingTransfer { key, offer, status, saved_path: None },
            cancel: CancellationToken::new(),
        });
        self.changed();
        Ok((true, status))
    }

    pub(crate) fn start(self: &Arc<Self>, key: TransferKey, size: u64) -> Result<Upload, TransferError> {
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, key)?;
        match entry.transfer.status.state {
            State::Rejected => return Err(ErrorCode::TransferRejected.into()),
            State::Accepted => {}
            _ => return Err(ErrorCode::Conflict.into()),
        }
        if entry.transfer.offer.size_bytes != size {
            return Err(ErrorCode::InvalidRequest.into());
        }
        entry.transfer.status.state = State::Transferring;
        self.changed();
        Ok(Upload {
            receiver: Arc::clone(self),
            key,
            offer: entry.transfer.offer.clone(),
            cancel: entry.cancel.clone(),
        })
    }

    fn entries(&self) -> MutexGuard<'_, HashMap<TransferKey, Entry>> {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn entry(entries: &mut HashMap<TransferKey, Entry>, key: TransferKey) -> Result<&mut Entry, TransferError> {
        entries.get_mut(&key).ok_or_else(|| ErrorCode::PeerUnavailable.into())
    }

    fn changed(&self) {
        self.changes.send_modify(|generation| *generation = generation.wrapping_add(1));
    }

    fn cancel_entry(entry: &mut Entry) -> bool {
        if entry.transfer.status.state.is_terminal() {
            return false;
        }
        entry.transfer.status.state = State::Cancelled;
        entry.cancel.cancel();
        true
    }
}

pub(crate) struct Upload {
    receiver: Arc<Receiver>,
    key: TransferKey,
    pub offer: Offer,
    pub cancel: CancellationToken,
}

impl Upload {
    pub fn tempfile(&self) -> Result<NamedTempFile, TransferError> {
        tempfile::Builder::new().prefix(".aerift-part-")
            .tempfile_in(&self.receiver.destination).map_err(|_| ErrorCode::StorageFailed.into())
    }

    pub fn progress(&self, bytes: u64) -> Result<(), TransferError> {
        let mut entries = self.receiver.entries();
        let entry = Receiver::entry(&mut entries, self.key)?;
        if entry.transfer.status.state != State::Transferring {
            return Err(ErrorCode::Cancelled.into());
        }
        entry.transfer.status.bytes_transferred = bytes;
        self.receiver.changed();
        Ok(())
    }

    pub fn publish(&self, mut file: NamedTempFile) -> Result<Status, TransferError> {
        let mut entries = self.receiver.entries();
        let entry = Receiver::entry(&mut entries, self.key)?;
        if entry.transfer.status.state != State::Transferring {
            return Err(ErrorCode::Cancelled.into());
        }
        for suffix in 0..1000 {
            let name = if suffix == 0 {
                self.offer.name.clone()
            } else {
                format!("{suffix}-{}", self.offer.name)
            };
            let destination = self.receiver.destination.join(name);
            match file.persist_noclobber(&destination) {
                Ok(_) => {
                    entry.transfer.saved_path = Some(destination);
                    entry.transfer.status.state = State::Completed;
                    self.receiver.changed();
                    return Ok(entry.transfer.status);
                }
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    file = error.file;
                }
                Err(_) => return Err(ErrorCode::StorageFailed.into()),
            }
        }
        Err(ErrorCode::Conflict.into())
    }

    pub fn fail(&self, error: TransferError) {
        let mut entries = self.receiver.entries();
        if let Ok(entry) = Receiver::entry(&mut entries, self.key)
            && entry.transfer.status.state == State::Transferring
        {
            entry.transfer.status.state = State::Failed;
            entry.transfer.status.error = Some(error);
            self.receiver.changed();
        }
    }
}

impl Drop for Upload {
    fn drop(&mut self) {
        self.fail(ErrorCode::NetworkError.into());
    }
}
