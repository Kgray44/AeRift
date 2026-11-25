use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[cfg(unix)]
use crate::journal::{DurableCheckpoint, Journal};
#[cfg(test)]
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use tokio::sync::watch;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::ambient_inbox::{FrozenDelivery, Inbox};
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
    #[cfg(unix)]
    journal: Option<Journal>,
    ready_until: Mutex<Option<Instant>>,
    entries: Mutex<HashMap<TransferKey, Entry>>,
    stopped: AtomicBool,
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
    checkpoint: Option<ResumeStage>,
    committing: bool,
    cancel: CancellationToken,
    trust: CancellationToken,
    deadline: Instant,
    inbox: Option<(Arc<Inbox>, FrozenDelivery)>,
}

enum ResumeStage {
    Memory(Checkpoint),
    #[cfg(unix)]
    Durable(DurableCheckpoint),
}

impl ResumeStage {
    fn offset(&self) -> u64 {
        match self {
            Self::Memory(value) => value.offset(),
            #[cfg(unix)]
            Self::Durable(value) => value.offset(),
        }
    }

    fn append(&mut self, offset: u64, data: &[u8]) -> Result<u64, TransferError> {
        match self {
            Self::Memory(value) => value.append_block(offset, data).map_err(checkpoint_failure),
            #[cfg(unix)]
            Self::Durable(value) => value.append(offset, data),
        }
    }

    fn discard(self) {
        // If storage is temporarily inaccessible we still cancel authority.
        // A surviving disk stage cannot resume without fresh approval.
        #[cfg(unix)]
        if let Self::Durable(value) = self {
            let _ = value.discard();
        }
    }
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

    /// Unix development opt-in. Caller supplies a private, 0700,
    /// same-volume journal directory and must run disk-heavy approval off the UI thread.
    #[cfg(unix)]
    pub fn with_restart_journal(
        destination: &Path,
        journal_directory: &Path,
        limits: ReceiveLimits,
    ) -> Result<Self, TransferError> {
        use std::os::unix::fs::MetadataExt;
        let mut receiver = Self::new_resumable(destination, limits)?;
        let journal_path = journal_directory
            .canonicalize()
            .map_err(|_| ErrorCode::StorageFailed)?;
        let destination_dev = receiver
            .destination
            .metadata()
            .map_err(|_| ErrorCode::StorageFailed)?
            .dev();
        let journal_dev = journal_path
            .metadata()
            .map_err(|_| ErrorCode::StorageFailed)?
            .dev();
        if journal_path == receiver.destination
            || !journal_path.is_dir()
            || journal_dev != destination_dev
        {
            return Err(ErrorCode::StorageFailed.into());
        }
        receiver.journal = Some(Journal::open(
            journal_directory,
            limits.active_bytes,
            limits.session_offers,
        )?);
        Ok(receiver)
    }

    #[cfg(unix)]
    pub fn discard_restart_checkpoints_for_peer(&self, peer: PeerId) -> Result<(), TransferError> {
        if let Some(journal) = &self.journal {
            journal.discard_peer(peer)?;
        }
        Ok(())
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
            #[cfg(unix)]
            journal: None,
            ready_until: Mutex::default(),
            entries: Mutex::default(),
            stopped: AtomicBool::new(false),
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

    /// Native lookup of one verified regular receipt. No directory scan or
    /// snapshot of unrelated transfers, and never returns an in-flight offer.
    pub fn completed_receipt(&self, key: TransferKey) -> Option<IncomingTransfer> {
        let entries = self.entries();
        let receipt = &entries.get(&key)?.transfer;
        (receipt.status.state == State::Completed
            && receipt.status.error.is_none()
            && receipt.status.bytes_transferred == receipt.offer.size_bytes
            && receipt.saved_path.is_some())
        .then(|| receipt.clone())
    }

    pub fn respond(&self, key: TransferKey, accept: bool) -> Result<Status, TransferError> {
        self.respond_inner(key, accept, None)
    }

    /// Accept into the application-owned inbox instead of the ordinary receive
    /// folder. Only the local host may call this. The choice is frozen by the
    /// same transition that reserves and accepts the authenticated offer.
    pub fn respond_to_inbox(
        &self,
        key: TransferKey,
        inbox: Arc<Inbox>,
        destination: FrozenDelivery,
    ) -> Result<Status, TransferError> {
        self.respond_inner(key, true, Some((inbox, destination)))
    }

    fn respond_inner(
        &self,
        key: TransferKey,
        accept: bool,
        inbox: Option<(Arc<Inbox>, FrozenDelivery)>,
    ) -> Result<Status, TransferError> {
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
        // Inbox v1 stage and resumable checkpoint have different publish contracts.
        if inbox.is_some() && entry.mode == Mode::Resumable {
            return Err(ErrorCode::InvalidRequest.into());
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
        #[cfg(unix)]
        if let Some(journal) = self
            .journal
            .as_ref()
            .filter(|_| entry.mode == Mode::Resumable)
        {
            if accept {
                let stage = journal.approve(key, &entry.transfer.offer)?;
                entry.transfer.status.bytes_transferred = stage.offset();
                entry.checkpoint = Some(ResumeStage::Durable(stage));
            } else {
                journal.discard(key)?;
            }
        }
        entry.inbox = inbox;
        entry.transfer.status.state = if accept {
            if entry.transfer.status.bytes_transferred > 0 {
                State::Transferring
            } else {
                State::Accepted
            }
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

    /// Close this receiver's session without modifying persisted peer grants.
    /// Shares the lock held across final publication: releases unpublished
    /// stages and returns only after any earlier publication leaves that gate.
    /// A later session must construct a fresh Receiver.
    pub fn stop_receiving(&self) {
        let mut entries = self.entries();
        self.stopped.store(true, Ordering::Relaxed);
        let mut changed = false;
        for entry in entries.values_mut() {
            changed |= Self::cancel_entry(entry);
        }
        if changed {
            self.changed();
        }
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
        // Read and write this session barrier only under the same entries lock.
        if self.stopped.load(Ordering::Relaxed) {
            return Err(ErrorCode::Cancelled.into());
        }
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
        #[cfg(unix)]
        if let Some(journal) = self.journal.as_ref().filter(|_| mode == Mode::Resumable) {
            journal.inspect(key, &offer)?;
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
                inbox: None,
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
            inbox: entry.inbox.as_ref().map(|(inbox, _)| inbox.clone()),
        })
    }

    pub(crate) fn completed_resumable(
        &self,
        key: TransferKey,
    ) -> Result<(IncomingTransfer, CancellationToken), TransferError> {
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, key)?;
        if entry.mode != Mode::Resumable
            || entry.transfer.status.state != State::Completed
            || entry.trust.is_cancelled()
            || entry.transfer.saved_path.is_none()
        {
            return Err(ErrorCode::Conflict.into());
        }
        Ok((entry.transfer.clone(), entry.trust.clone()))
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

    fn create_checkpoint(&self, offer: &Offer) -> Result<ResumeStage, TransferError> {
        let mut digest = [0_u8; 32];
        for (i, byte) in digest.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&offer.sha256[i * 2..i * 2 + 2], 16)
                .map_err(|_| ErrorCode::InvalidRequest)?;
        }
        Checkpoint::create(&self.staging, offer.size_bytes, digest)
            .map(ResumeStage::Memory)
            .map_err(checkpoint_failure)
    }

    pub(crate) fn append_resumable(
        &self,
        key: TransferKey,
        offset: u64,
        data: &[u8],
    ) -> Result<Status, TransferError> {
        let mut entries = self.entries();
        let entry = Self::entry(&mut entries, key)?;
        self.check_chunk(entry, offset, data.len() as u64)?;
        if entry.checkpoint.is_none() {
            entry.checkpoint = Some(self.create_checkpoint(&entry.transfer.offer)?);
        }
        let checkpoint = entry.checkpoint.as_mut().ok_or(ErrorCode::InternalError)?;
        let committed = checkpoint.append(offset, data)?;
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
                    inbox: None,
                },
                checkpoint,
            )
        };
        let result = match checkpoint {
            ResumeStage::Memory(checkpoint) => checkpoint
                .finish()
                .map_err(checkpoint_failure)
                .and_then(|file| upload.publish(file)),
            #[cfg(unix)]
            ResumeStage::Durable(mut checkpoint) => {
                let result = checkpoint
                    .verify_complete()
                    .and_then(|()| upload.publish_durable(&mut checkpoint));
                if result
                    .as_ref()
                    .is_err_and(|error| error.code == ErrorCode::Cancelled)
                {
                    let _ = checkpoint.discard();
                }
                result
            }
        };
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
            if let Some(stage) = entry.checkpoint.take() {
                stage.discard();
            }
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
        if let Some(stage) = entry.checkpoint.take() {
            stage.discard();
        }
        entry.cancel.cancel();
        true
    }
}

fn checkpoint_failure(error: checkpoint::Error) -> TransferError {
    match error {
        #[cfg(test)]
        checkpoint::Error::BlockDigest => ErrorCode::IntegrityFailed,
        checkpoint::Error::InvalidRange => ErrorCode::InvalidRequest,
        checkpoint::Error::PrefixMismatch | checkpoint::Error::FileDigest => {
            ErrorCode::IntegrityFailed
        }
        checkpoint::Error::Incomplete => ErrorCode::Conflict,
        #[cfg(test)]
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
    inbox: Option<Arc<Inbox>>,
}

impl Upload {
    pub fn tempfile(&self) -> Result<NamedTempFile, TransferError> {
        if let Some(inbox) = &self.inbox {
            return inbox.tempfile();
        }
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
        if let Some((inbox, destination)) = &entry.inbox {
            let path = inbox.publish(self.key, &self.offer, *destination, file)?;
            entry.transfer.saved_path = Some(path);
            entry.transfer.status.state = State::Completed;
            self.receiver.changed();
            return Ok(entry.transfer.status);
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

    #[cfg(unix)]
    fn publish_durable(&self, checkpoint: &mut DurableCheckpoint) -> Result<Status, TransferError> {
        let mut entries = self.receiver.entries();
        let entry = Receiver::entry(&mut entries, self.key)?;
        if Receiver::reap_entry(entry, Instant::now()) {
            self.receiver.changed();
        }
        if entry.transfer.status.state != State::Transferring || !entry.committing {
            return Err(ErrorCode::Cancelled.into());
        }
        let path = checkpoint.publish_verified(&self.receiver.destination, || {
            !self.cancel.is_cancelled() && !self.trust.is_cancelled()
        })?;
        entry.transfer.saved_path = Some(path);
        entry.transfer.status.state = State::Completed;
        self.receiver.changed();
        Ok(entry.transfer.status)
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

    #[cfg(unix)]
    fn process_fixture() -> (TransferKey, Offer, Vec<u8>) {
        let data = vec![0xC8; RESUMABLE_CHUNK_SIZE + 119];
        let key = TransferKey {
            peer: PeerId::from_tls_leaf(b"stable synthetic peer"),
            id: "c6991e6c-ecd2-4f10-905c-0f254040dda7".parse().unwrap(),
        };
        let offer = Offer {
            id: key.id,
            name: "crash-probe.bin".to_owned(),
            size_bytes: data.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&data)),
        };
        (key, offer, data)
    }

    #[cfg(unix)]
    fn subprocess_receiver(root: &std::path::Path) -> Arc<Receiver> {
        Arc::new(
            Receiver::with_restart_journal(
                &root.join("destination"),
                &root.join("journal"),
                ReceiveLimits {
                    session_offers: 4,
                    active_bytes: 8 * 1024 * 1024,
                },
            )
            .unwrap(),
        )
    }

    #[cfg(unix)]
    #[test]
    fn journal_crash_fixture() {
        use std::io::Write;
        let Some(root) = std::env::var_os("AERIFT_PRIVATE_JOURNAL_FIXTURE_DIR") else {
            return;
        };
        let rx = subprocess_receiver(std::path::Path::new(&root));
        let (key, offer, data) = process_fixture();
        rx.offer_resumable(key.peer, offer, &CancellationToken::new())
            .unwrap();
        rx.respond(key, true).unwrap();
        rx.append_resumable(key, 0, &data[..RESUMABLE_CHUNK_SIZE])
            .unwrap();
        println!("aerift-checkpoint-synchronized");
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park();
        }
    }

    #[cfg(unix)]
    #[test]
    fn abrupt_process_exit_recovers_only_authenticated_approved_prefix() {
        use std::{
            io::BufRead,
            os::unix::fs::PermissionsExt,
            process::{Command, Stdio},
            sync::mpsc,
        };
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("destination")).unwrap();
        let journal = root.path().join("journal");
        std::fs::create_dir(&journal).unwrap();
        std::fs::set_permissions(journal, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "receiver::tests::journal_crash_fixture",
                "--nocapture",
            ])
            .env("AERIFT_PRIVATE_JOURNAL_FIXTURE_DIR", root.path())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = child.stdout.take().unwrap();
        let (report, status) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let found = std::io::BufReader::new(output)
                .lines()
                .map_while(Result::ok)
                .any(|line| line.contains("aerift-checkpoint-synchronized"));
            let _ = report.send(found);
        });
        let found = status.recv_timeout(Duration::from_secs(10));
        let killed = child.kill();
        let exit = child.wait().unwrap();
        reader.join().unwrap();
        assert!(found.unwrap() && killed.is_ok() && !exit.success());
        let rx = subprocess_receiver(root.path());
        let (key, offer, data) = process_fixture();
        let (_, status) = rx
            .offer_resumable(key.peer, offer, &CancellationToken::new())
            .unwrap();
        assert_eq!(status, Status::new(State::Pending));
        let split = RESUMABLE_CHUNK_SIZE as u64;
        assert!(
            rx.append_resumable(key, split, &data[RESUMABLE_CHUNK_SIZE..])
                .is_err()
        );
        assert_eq!(rx.respond(key, true).unwrap().bytes_transferred, split);
        rx.append_resumable(key, split, &data[RESUMABLE_CHUNK_SIZE..])
            .unwrap();
        assert_eq!(rx.commit_resumable(key).unwrap().state, State::Completed);
        assert_eq!(
            std::fs::read(root.path().join("destination/crash-probe.bin")).unwrap(),
            data
        );
    }

    #[cfg(unix)]
    #[test]
    fn restart_requires_fresh_allow_uses_verified_offset_and_never_clobbers() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let destination = fixture.path().join("received");
        let journal = fixture.path().join("private-journal");
        std::fs::create_dir(&destination).unwrap();
        std::fs::create_dir(&journal).unwrap();
        std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o700)).unwrap();
        let make_rx = || {
            Arc::new(
                Receiver::with_restart_journal(
                    &destination,
                    &journal,
                    ReceiveLimits {
                        active_bytes: 8 * 1024 * 1024,
                        session_offers: 4,
                    },
                )
                .unwrap(),
            )
        };
        let head = vec![15; RESUMABLE_CHUNK_SIZE];
        let tail = b"crash-safe";
        let mut bytes = head.clone();
        bytes.extend_from_slice(tail);
        let key = TransferKey {
            peer: PeerId::from_tls_leaf(b"first authorized peer"),
            id: Uuid::new_v4(),
        };
        let offer = Offer {
            id: key.id,
            name: "held.bin".to_owned(),
            size_bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        };
        let trust = CancellationToken::new();
        {
            let rx = make_rx();
            rx.offer_resumable(key.peer, offer.clone(), &trust).unwrap();
            rx.respond(key, true).unwrap();
            rx.append_resumable(key, 0, &head).unwrap();
            assert!(!destination.join("held.bin").exists());
        }
        {
            let rx = make_rx();
            let (_, state) = rx.offer_resumable(key.peer, offer.clone(), &trust).unwrap();
            assert_eq!(state, Status::new(State::Pending));
            assert!(rx.append_resumable(key, head.len() as u64, tail).is_err());
            let status = rx.respond(key, true).unwrap();
            assert_eq!(status.bytes_transferred, head.len() as u64);
            assert_eq!(status.state, State::Transferring);
            rx.append_resumable(key, head.len() as u64, tail).unwrap();
            // A pre-existing destination must not be confused with our publication.
            std::fs::write(destination.join("held.bin"), b"other local file").unwrap();
            assert_eq!(rx.commit_resumable(key).unwrap().state, State::Completed);
            assert_eq!(
                std::fs::read(destination.join("1-held.bin")).unwrap(),
                bytes
            );
        }
        let rx = make_rx();
        assert_eq!(
            rx.offer_resumable(key.peer, offer.clone(), &trust)
                .unwrap()
                .1
                .state,
            State::Pending
        );
        assert!(rx.commit_resumable(key).is_err());
        assert_eq!(
            rx.respond(key, true).unwrap().bytes_transferred,
            bytes.len() as u64
        );
        assert_eq!(rx.commit_resumable(key).unwrap().state, State::Completed);
        assert_eq!(
            std::fs::read(destination.join("held.bin")).unwrap(),
            b"other local file"
        );
        assert!(!destination.join("2-held.bin").exists());
        rx.discard_restart_checkpoints_for_peer(key.peer).unwrap();
        assert!(!journal.join(format!("{}-{}", key.peer, key.id)).exists());
        assert!(destination.join("1-held.bin").exists());
    }

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
        assert!(rx.completed_receipt(key).is_none());
        assert_eq!(rx.commit_resumable(key).unwrap().state, State::Completed);
        assert_eq!(rx.commit_resumable(key).unwrap().state, State::Completed);
        let receipt = rx.completed_receipt(key).unwrap();
        // Windows can return a pinned long path while TEMP uses a short alias.
        // Both must resolve to the expected published file.
        assert_eq!(
            receipt.saved_path.as_ref().unwrap().canonicalize().unwrap(),
            final_path.canonicalize().unwrap()
        );
        assert_eq!(
            receipt.offer.sha256,
            format!("{:x}", Sha256::digest(&bytes))
        );
        let other = TransferKey {
            peer: PeerId::from_tls_leaf(b"other peer"),
            id: key.id,
        };
        assert!(rx.completed_receipt(other).is_none());
        assert_eq!(std::fs::read(final_path).unwrap(), bytes);
    }

    #[test]
    fn stopped_receiver_rejects_verified_checkpoint_and_keeps_prior_publication() {
        let directory = tempfile::tempdir().unwrap();
        let rx = Arc::new(
            Receiver::new_resumable(
                directory.path(),
                ReceiveLimits {
                    active_bytes: 1024,
                    session_offers: 4,
                },
            )
            .unwrap(),
        );
        let trust = CancellationToken::new();
        let prepare = |file: &str, bytes: &[u8]| {
            let key = TransferKey {
                peer: PeerId::from_tls_leaf(b"synthetic receiver-session peer"),
                id: Uuid::new_v4(),
            };
            let offer = Offer {
                id: key.id,
                name: file.into(),
                size_bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
            };
            rx.offer_resumable(key.peer, offer.clone(), &trust).unwrap();
            rx.respond(key, true).unwrap();
            rx.append_resumable(key, 0, bytes).unwrap();
            (key, offer)
        };
        let (prior, _) = prepare("prior.bin", b"already delivered");
        let published = rx.commit_resumable(prior).unwrap();
        assert_eq!(published.state, State::Completed);
        let (pending, pending_offer) = prepare("unpublished.bin", b"fully acknowledged");
        // Model a benign worker paused after taking its checkpoint but before
        // publication. No socket or timing assumptions needed.
        let (worker, stage) = {
            let mut entries = rx.entries();
            let entry = Receiver::entry(&mut entries, pending).unwrap();
            entry.committing = true;
            let Some(ResumeStage::Memory(checkpoint)) = entry.checkpoint.take() else {
                panic!("fixture requires an in-process verified checkpoint");
            };
            (
                Upload {
                    receiver: rx.clone(),
                    key: pending,
                    offer: entry.transfer.offer.clone(),
                    cancel: entry.cancel.clone(),
                    trust: entry.trust.clone(),
                    inbox: None,
                },
                checkpoint.finish().unwrap(),
            )
        };
        rx.stop_receiving();
        rx.stop_receiving();
        assert!(rx.commit_resumable(pending).is_err());
        assert_eq!(
            worker.publish(stage).unwrap_err().code,
            ErrorCode::Cancelled
        );
        assert!(!directory.path().join("unpublished.bin").exists());
        assert_eq!(
            rx.status_resumable(pending).unwrap().state,
            State::Cancelled
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        assert_eq!(rx.commit_resumable(prior).unwrap(), published);
        assert_eq!(
            std::fs::read(directory.path().join("prior.bin")).unwrap(),
            b"already delivered"
        );
        assert_eq!(
            rx.offer_resumable(pending.peer, pending_offer, &trust)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert!(!trust.is_cancelled());
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

#[cfg(test)]
mod inbox_tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    #[test]
    fn authenticated_completion_falls_back_to_persistent_inbox_and_is_auditable() {
        let root = tempfile::tempdir().unwrap();
        let ordinary = tempfile::tempdir().unwrap();
        let inbox = Arc::new(Inbox::open(root.path()).unwrap());
        let receiver = Arc::new(
            Receiver::new(
                ordinary.path(),
                ReceiveLimits {
                    active_bytes: 100,
                    session_offers: 2,
                },
            )
            .unwrap(),
        );
        let key = TransferKey {
            peer: PeerId::from_tls_leaf(b"fixture"),
            id: Uuid::new_v4(),
        };
        let trust = CancellationToken::new();
        let payload = b"verified";
        receiver
            .offer(
                key.peer,
                Offer {
                    id: key.id,
                    name: "fixture.bin".into(),
                    size_bytes: payload.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(payload)),
                },
                &trust,
            )
            .unwrap();
        receiver
            .respond_to_inbox(
                key,
                inbox.clone(),
                FrozenDelivery::ExternalRequiresAuthorization,
            )
            .unwrap();
        assert!(inbox.verified_receipt(key).is_err());
        let upload = receiver.start(key, payload.len() as u64).unwrap();
        let mut file = upload.tempfile().unwrap();
        file.write_all(payload).unwrap();
        file.as_file().sync_all().unwrap();
        let status = upload.publish(file).unwrap();
        assert_eq!(status.state, State::Completed);
        assert_eq!(std::fs::read_dir(ordinary.path()).unwrap().count(), 0);
        let saved = receiver.snapshot()[0].saved_path.clone().unwrap();
        let reopened = Inbox::open(root.path()).unwrap();
        let receipt = reopened.verified_receipt(key).unwrap();
        assert_eq!(
            receipt.requested_destination(),
            FrozenDelivery::ExternalRequiresAuthorization
        );
        assert_eq!(receipt.offer().name, "fixture.bin");
        std::fs::write(saved, b"tampered").unwrap(); // same size, different digest
        assert!(reopened.verified_receipt(key).is_err());
    }
}
