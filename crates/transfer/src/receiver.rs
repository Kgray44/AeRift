use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    ErrorCode, Offer, PeerId, RESUMABLE_CHUNK_SIZE, State, Status, TransferError,
    checkpoint::{self, Checkpoint},
};

const OFFER_TIMEOUT: Duration = Duration::from_secs(300);

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
    staging: PathBuf,
    limits: ReceiveLimits,
    resumable: bool,
    ready_until: Mutex<Option<Instant>>,
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

#[derive(Clone, Copy, Eq, PartialEq)]
enum Mode {
    Legacy,
    Resumable,
}

struct Entry {
    transfer: IncomingTransfer,
    mode: Mode,
    checkpoint: Option<Checkpoint>,
    committing: bool,
    cancel: CancellationToken,
    trust: CancellationToken,
    deadline: Instant,
}

impl Receiver {
    /// The native host provides a private, receiver-owned directory.
    pub fn new(destination: &Path, limits: ReceiveLimits) -> Result<Self, TransferError> {
        Self::with_staging_directory(destination, destination, limits)
    }

    /// Opt in to versioned resumable file uploads on an isolated Remote host.
    /// Normal Nearby Receivers do not accept the new version.
    pub fn new_resumable(destination: &Path, limits: ReceiveLimits) -> Result<Self, TransferError> {
        let mut receiver = Self::new(destination, limits)?;
        receiver.resumable = true;
        Ok(receiver)
    }

    pub(crate) fn resumable_enabled(&self) -> bool {
        self.resumable
    }

    /// Stage incomplete transfers in a private, receiver-owned directory.
    ///
    /// The native host must provide existing directories on the same volume so
    /// verified files can be published without overwriting an existing file.
    pub fn with_staging_directory(
        destination: &Path,
        staging: &Path,
        limits: ReceiveLimits,
    ) -> Result<Self, TransferError> {
        let destination = destination
            .canonicalize()
            .map_err(|_| ErrorCode::StorageFailed)?;
        let staging = staging
            .canonicalize()
            .map_err(|_| ErrorCode::StorageFailed)?;
        if !destination.is_dir() || !staging.is_dir() {
            return Err(ErrorCode::StorageFailed.into());
        }
        let (changes, _) = watch::channel(0);
        Ok(Self {
            destination,
            staging,
            limits,
            resumable: false,
            ready_until: Mutex::default(),
            entries: Mutex::default(),
            changes,
        })
    }

    /// A local, expiring availability signal. Each offer still requires a separate approval.
    pub fn set_ready_until(&self, deadline: Option<Instant>) {
        *self
            .ready_until
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = deadline;
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.ready_until
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some_and(|deadline| deadline > Instant::now())
    }

    /// Native-only path for checking the volume that receives partial files.
    pub fn staging_directory(&self) -> &Path {
        &self.staging
    }

    /// Subscribe before enumerating transfers. A watch wakeup may represent multiple updates.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub fn snapshot(&self) -> Vec<IncomingTransfer> {
        let mut entries = self.entries();
        self.reap(&mut entries);
        entries
            .values()
            .map(|entry| entry.transfer.clone())
            .collect()
    }

    pub fn respond(&self, key: TransferKey, accept: bool) -> Result<Status, TransferError> {
        let mut entries = self.entries();
        self.reap(&mut entries);
        let active = entries
            .values()
            .filter(|entry| {
                matches!(
                    entry.transfer.status.state,
                    State::Accepted | State::Transferring
                )
            })
            .map(|entry| entry.transfer.offer.size_bytes)
            .fold(0u64, u64::saturating_add);
        let entry = Self::entry(&mut entries, key)?;
        if entry.transfer.status.state != State::Pending {
            return Err(ErrorCode::Conflict.into());
        }
        if accept
            && entry.transfer.offer.size_bytes > self.limits.active_bytes.saturating_sub(active)
        {
            entry.transfer.status = Status {
                state: State::Failed,
                bytes_transferred: 0,
                error: Some(ErrorCode::StorageFailed.into()),
            };
            self.changed();
            return Err(ErrorCode::StorageFailed.into());
        }
        entry.transfer.status.state = if accept {
            State::Accepted
        } else {
            State::Rejected
        };
        entry.deadline = Instant::now() + OFFER_TIMEOUT;
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
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, key)?;
        if Self::reap_entry(entry, Instant::now()) {
            self.changed();
        }
        Ok(entry.transfer.status)
    }

    /// Call from the listener's housekeeping tick to expire offers while idle.
    pub fn expire_offers(&self) {
        self.reap(&mut self.entries());
    }

    pub(crate) fn offer(
        &self,
        peer: PeerId,
        offer: Offer,
        trust: &CancellationToken,
    ) -> Result<(bool, Status), TransferError> {
        self.offer_mode(peer, offer, trust, Mode::Legacy)
    }

    pub(crate) fn offer_resumable(
        &self,
        peer: PeerId,
        offer: Offer,
        trust: &CancellationToken,
    ) -> Result<(bool, Status), TransferError> {
        if !self.resumable {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        self.offer_mode(peer, offer, trust, Mode::Resumable)
    }

    fn offer_mode(
        &self,
        peer: PeerId,
        offer: Offer,
        trust: &CancellationToken,
        mode: Mode,
    ) -> Result<(bool, Status), TransferError> {
        offer.validate()?;
        let key = TransferKey { peer, id: offer.id };
        let mut entries = self.entries();
        if trust.is_cancelled() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        if let Some(entry) = entries.get_mut(&key) {
            if Self::reap_entry(entry, Instant::now()) {
                self.changed();
            }
            if entry.transfer.offer == offer && entry.mode == mode {
                return Ok((false, entry.transfer.status));
            }
            return Err(ErrorCode::Conflict.into());
        }
        if entries.len() >= self.limits.session_offers {
            return Err(ErrorCode::Conflict.into());
        }
        let status = Status::new(State::Pending);
        entries.insert(
            key,
            Entry {
                transfer: IncomingTransfer {
                    key,
                    offer,
                    status,
                    saved_path: None,
                },
                mode,
                checkpoint: None,
                committing: false,
                cancel: CancellationToken::new(),
                trust: trust.clone(),
                deadline: Instant::now() + OFFER_TIMEOUT,
            },
        );
        self.changed();
        Ok((true, status))
    }

    pub(crate) fn start(
        self: &Arc<Self>,
        key: TransferKey,
        size: u64,
    ) -> Result<Upload, TransferError> {
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, key)?;
        if Self::reap_entry(entry, Instant::now()) {
            self.changed();
        }
        if entry.mode != Mode::Legacy {
            return Err(ErrorCode::Conflict.into());
        }
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
            trust: entry.trust.clone(),
        })
    }

    pub(crate) fn status_legacy(&self, key: TransferKey) -> Result<Status, TransferError> {
        self.status_mode(key, Mode::Legacy, false)
    }

    pub(crate) fn cancel_legacy(&self, key: TransferKey) -> Result<Status, TransferError> {
        self.status_mode(key, Mode::Legacy, true)
    }

    pub(crate) fn status_resumable(&self, key: TransferKey) -> Result<Status, TransferError> {
        self.status_mode(key, Mode::Resumable, false)
    }

    pub(crate) fn cancel_resumable(&self, key: TransferKey) -> Result<Status, TransferError> {
        self.status_mode(key, Mode::Resumable, true)
    }

    fn status_mode(
        &self,
        key: TransferKey,
        mode: Mode,
        cancel: bool,
    ) -> Result<Status, TransferError> {
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, key)?;
        if entry.mode != mode {
            return Err(ErrorCode::Conflict.into());
        }
        let changed = if cancel {
            Self::cancel_entry(entry)
        } else {
            Self::reap_entry(entry, Instant::now())
        };
        if changed {
            self.changed();
        }
        Ok(entry.transfer.status)
    }

    pub(crate) fn can_append_resumable(
        &self,
        key: TransferKey,
        offset: u64,
        size: u64,
    ) -> Result<(), TransferError> {
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, key)?;
        self.check_chunk(entry, offset, size)
    }

    fn check_chunk(&self, entry: &mut Entry, offset: u64, size: u64) -> Result<(), TransferError> {
        self.require_resumable(entry)?;
        let max = RESUMABLE_CHUNK_SIZE as u64;
        let remaining = entry.transfer.offer.size_bytes.saturating_sub(offset);
        if !offset.is_multiple_of(max)
            || offset > entry.transfer.status.bytes_transferred
            || size == 0
            || size != remaining.min(max)
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(())
    }

    fn require_resumable(&self, entry: &mut Entry) -> Result<(), TransferError> {
        if Self::reap_entry(entry, Instant::now()) {
            self.changed();
        }
        if entry.mode != Mode::Resumable
            || entry.committing
            || !matches!(
                entry.transfer.status.state,
                State::Accepted | State::Transferring
            )
        {
            return Err(ErrorCode::Conflict.into());
        }
        Ok(())
    }

    fn create_checkpoint(&self, offer: &Offer) -> Result<Checkpoint, TransferError> {
        let mut digest = [0_u8; 32];
        for (i, byte) in digest.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&offer.sha256[i * 2..i * 2 + 2], 16)
                .map_err(|_| ErrorCode::InvalidRequest)?;
        }
        Checkpoint::create(&self.staging, offer.size_bytes, digest).map_err(checkpoint_failure)
    }

    pub(crate) fn append_resumable(
        &self,
        key: TransferKey,
        offset: u64,
        data: &[u8],
    ) -> Result<Status, TransferError> {
        let digest = Sha256::digest(data).into();
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, key)?;
        self.check_chunk(entry, offset, data.len() as u64)?;
        if entry.checkpoint.is_none() {
            entry.checkpoint = Some(self.create_checkpoint(&entry.transfer.offer)?);
        }
        let checkpoint = entry.checkpoint.as_mut().ok_or(ErrorCode::InternalError)?;
        let committed = checkpoint
            .append(offset, data.len(), digest, &mut std::io::Cursor::new(data))
            .map_err(checkpoint_failure)?;
        if Self::reap_entry(entry, Instant::now()) {
            self.changed();
            return Err(ErrorCode::Cancelled.into());
        }
        if committed > entry.transfer.status.bytes_transferred {
            entry.transfer.status.state = State::Transferring;
            entry.transfer.status.bytes_transferred = committed;
            entry.deadline = Instant::now() + OFFER_TIMEOUT;
            self.changed();
        }
        Ok(entry.transfer.status)
    }

    pub(crate) fn commit_resumable(
        self: &Arc<Self>,
        key: TransferKey,
    ) -> Result<Status, TransferError> {
        let (upload, checkpoint) = {
            let mut entries = self.entries();
            let entry = Self::entry(&mut entries, key)?;
            if entry.mode == Mode::Resumable && entry.transfer.status.state == State::Completed {
                return Ok(entry.transfer.status); // lost verified commit response
            }
            self.require_resumable(entry)?;
            if entry.transfer.status.bytes_transferred != entry.transfer.offer.size_bytes {
                return Err(ErrorCode::Conflict.into());
            }
            let checkpoint = entry
                .checkpoint
                .take()
                .map_or_else(|| self.create_checkpoint(&entry.transfer.offer), Ok)?;
            if checkpoint.offset() != entry.transfer.offer.size_bytes {
                return Err(ErrorCode::IntegrityFailed.into());
            }
            entry.committing = true;
            entry.transfer.status.state = State::Transferring;
            self.changed();
            (
                Upload {
                    receiver: self.clone(),
                    key,
                    offer: entry.transfer.offer.clone(),
                    cancel: entry.cancel.clone(),
                    trust: entry.trust.clone(),
                },
                checkpoint,
            )
        };
        let result = checkpoint
            .finish()
            .map_err(checkpoint_failure)
            .and_then(|file| upload.publish(file));
        if let Err(error) = result {
            upload.fail(error);
        }
        result
    }

    fn entries(&self) -> MutexGuard<'_, HashMap<TransferKey, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reap(&self, entries: &mut HashMap<TransferKey, Entry>) {
        let now = Instant::now();
        let mut changed = false;
        for entry in entries.values_mut() {
            changed |= Self::reap_entry(entry, now);
        }
        if changed {
            self.changed();
        }
    }

    fn reap_entry(entry: &mut Entry, now: Instant) -> bool {
        if entry.trust.is_cancelled() {
            return Self::cancel_entry(entry);
        }
        if (matches!(
            entry.transfer.status.state,
            State::Pending | State::Accepted
        ) || (entry.mode == Mode::Resumable
            && !entry.committing
            && entry.transfer.status.state == State::Transferring))
            && entry.deadline <= now
        {
            entry.checkpoint.take();
            entry.transfer.status.state = State::Failed;
            entry.transfer.status.error = Some(ErrorCode::PeerUnavailable.into());
            return true;
        }
        false
    }

    fn entry(
        entries: &mut HashMap<TransferKey, Entry>,
        key: TransferKey,
    ) -> Result<&mut Entry, TransferError> {
        entries
            .get_mut(&key)
            .ok_or_else(|| ErrorCode::PeerUnavailable.into())
    }

    fn changed(&self) {
        self.changes
            .send_modify(|generation| *generation = generation.wrapping_add(1));
    }

    fn cancel_entry(entry: &mut Entry) -> bool {
        if entry.transfer.status.state.is_terminal() {
            return false;
        }
        entry.transfer.status.state = State::Cancelled;
        entry.checkpoint.take();
        entry.cancel.cancel();
        true
    }
}

fn checkpoint_failure(error: checkpoint::Error) -> TransferError {
    match error {
        checkpoint::Error::InvalidRange => ErrorCode::InvalidRequest,
        checkpoint::Error::PrefixMismatch
        | checkpoint::Error::BlockDigest
        | checkpoint::Error::FileDigest => ErrorCode::IntegrityFailed,
        checkpoint::Error::Incomplete => ErrorCode::Conflict,
        checkpoint::Error::Interrupted => ErrorCode::NetworkError,
        checkpoint::Error::Storage => ErrorCode::StorageFailed,
    }
    .into()
}

pub(crate) struct Upload {
    receiver: Arc<Receiver>,
    key: TransferKey,
    pub offer: Offer,
    pub cancel: CancellationToken,
    pub trust: CancellationToken,
}

impl Upload {
    pub fn tempfile(&self) -> Result<NamedTempFile, TransferError> {
        tempfile::Builder::new()
            .prefix(".aerift-part-")
            .tempfile_in(&self.receiver.staging)
            .map_err(|_| ErrorCode::StorageFailed.into())
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
        if Receiver::reap_entry(entry, Instant::now()) {
            self.receiver.changed();
        }
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
        if let Ok(entry) = Receiver::entry(&mut entries, self.key) {
            if Receiver::reap_entry(entry, Instant::now()) {
                self.receiver.changed();
            }
            if entry.transfer.status.state != State::Transferring {
                return;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumable_prefix_is_never_completion_and_requires_explicit_acceptance() {
        use sha2::{Digest, Sha256};
        let directory = tempfile::tempdir().unwrap();
        let rx = Arc::new(
            Receiver::new_resumable(
                directory.path(),
                ReceiveLimits {
                    active_bytes: 8 * 1024 * 1024,
                    session_offers: 4,
                },
            )
            .unwrap(),
        );
        let first = vec![42; crate::RESUMABLE_CHUNK_SIZE];
        let last = [17, 63, 55];
        let mut bytes = first.clone();
        bytes.extend_from_slice(&last);
        let key = TransferKey {
            peer: PeerId::from_tls_leaf(b"authenticated fixture"),
            id: Uuid::new_v4(),
        };
        let offer = Offer {
            id: key.id,
            name: "resume-fixture.bin".to_owned(),
            size_bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        };
        let trust = CancellationToken::new();
        rx.offer_resumable(key.peer, offer.clone(), &trust).unwrap();
        assert!(rx.append_resumable(key, 0, &first).is_err());
        rx.respond(key, true).unwrap();
        assert!(rx.offer(key.peer, offer, &trust).is_err());
        assert!(
            rx.status_resumable(TransferKey {
                peer: PeerId::from_tls_leaf(b"other peer"),
                id: key.id
            })
            .is_err()
        );
        assert_eq!(
            rx.append_resumable(key, 0, &first)
                .unwrap()
                .bytes_transferred,
            first.len() as u64
        );
        assert!(rx.commit_resumable(key).is_err());
        assert!(
            rx.append_resumable(key, first.len() as u64 + 1, &last)
                .is_err()
        );
        assert_eq!(
            rx.append_resumable(key, 0, &first)
                .unwrap()
                .bytes_transferred,
            first.len() as u64
        );
        assert_eq!(
            rx.append_resumable(key, first.len() as u64, &last)
                .unwrap()
                .state,
            State::Transferring
        );
        let final_path = directory.path().join("resume-fixture.bin");
        assert!(!final_path.exists());
        assert_eq!(rx.commit_resumable(key).unwrap().state, State::Completed);
        assert_eq!(rx.commit_resumable(key).unwrap().state, State::Completed);
        assert_eq!(std::fs::read(final_path).unwrap(), bytes);
    }

    #[test]
    fn expired_accepted_offer_releases_storage_reservation() {
        let dir = tempfile::tempdir().unwrap();
        let receiver = Receiver::new(
            dir.path(),
            ReceiveLimits {
                active_bytes: 10,
                session_offers: 4,
            },
        )
        .unwrap();
        let peer = PeerId::from_tls_leaf(b"fixture");
        let reserve = |name: &str| {
            let id = Uuid::new_v4();
            receiver
                .offer(
                    peer,
                    Offer {
                        id,
                        name: name.to_owned(),
                        size_bytes: 10,
                        sha256: "a".repeat(64),
                    },
                    &CancellationToken::new(),
                )
                .unwrap();
            let key = TransferKey { peer, id };
            receiver.respond(key, true).unwrap();
            key
        };
        let first = reserve("first.bin");
        receiver.entries().get_mut(&first).unwrap().deadline = Instant::now();
        let next = reserve("next.bin");
        let expired = receiver.status(first).unwrap();
        assert_eq!(expired.state, State::Failed);
        assert_eq!(expired.error.unwrap().code, ErrorCode::PeerUnavailable);
        assert_eq!(receiver.status(next).unwrap().state, State::Accepted);
    }
}
