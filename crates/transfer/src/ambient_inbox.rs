//! App-owned, persistent receiving for explicitly accepted offers. No archive
//! expansion, external writes, opening, or executing is performed by this API.

use crate::{ErrorCode, Offer, PeerId, TransferError, TransferKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::{Builder, NamedTempFile};

const RECEIPT_BYTES: u64 = 4096;
const SEALED_RECEIPT_BYTES: u64 = 16 * 1024;
const VERSION: u8 = 1;
const MAX_SCAN: usize = 1024;
const TEXT_PREVIEW_BYTES: u64 = 64 * 1024;
const CONTENT: &str = "payload";
const MARKER: &str = "verified.json";
const CLOCK_MARKER: &str = "received-time.sealed";
const CLOCK_FORMAT: &str = "aerift-inbox-clock-v1";
const MAX_DATE_MS: u64 = 8_640_000_000_000_000;

/// A deliberately conservative snapshot of the local destination at acceptance.
/// An external context is advisory only and may not cause an automatic write.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FrozenDelivery {
    Inbox,
    ExternalRequiresAuthorization,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    peer: PeerId,
    offer: Offer,
    requested_destination: FrozenDelivery,
}

/// Optional derivative display metadata. Never used for grant or payload checks.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReceiptClock {
    format: String,
    peer: PeerId,
    id: uuid::Uuid,
    digest: String,
    size_bytes: u64,
    received_at_unix_ms: u64,
}

fn valid_clock(value: u64) -> bool {
    value > 0 && value <= MAX_DATE_MS
}

/// Opaque proof produced by the local inbox; not a network or UI deserialization type.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedInboxReceipt(Record);

impl VerifiedInboxReceipt {
    pub fn offer(&self) -> &Offer {
        &self.0.offer
    }

    pub fn peer(&self) -> PeerId {
        self.0.peer
    }

    pub fn requested_destination(&self) -> FrozenDelivery {
        self.0.requested_destination
    }
}

/// Recovery candidates are persisted metadata, not fresh verification.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxCandidate {
    pub peer: PeerId,
    pub id: uuid::Uuid,
    pub name: String,
    pub size_bytes: u64,
    pub requested_destination: FrozenDelivery,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_at_unix_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct InboxPage {
    pub entries: Vec<InboxCandidate>,
    pub truncated: bool,
}

/// Host-provided receipt authentication bound to its private OS identity.
pub trait InboxReceiptSeal: Send + Sync {
    fn seal(&self, bytes: &[u8]) -> io::Result<Vec<u8>>;
    fn unseal(&self, bytes: &[u8]) -> io::Result<Vec<u8>>;
}

/// The native host owns the canonical directory and its access controls. Never
/// configure this under an editable receive folder, download path or network share.
pub struct Inbox {
    root: PathBuf,
    verification: Mutex<()>,
    seal: Option<Arc<dyn InboxReceiptSeal>>,
}

impl Inbox {
    pub fn open(private_root: &Path) -> Result<Self, TransferError> {
        Self::open_inner(private_root, None)
    }

    /// Require a native OS-authenticated seal for every restore and publish.
    /// Plain records are never implicitly trusted or migrated.
    pub fn open_sealed(
        private_root: &Path,
        seal: Arc<dyn InboxReceiptSeal>,
    ) -> Result<Self, TransferError> {
        Self::open_inner(private_root, Some(seal))
    }

    fn open_inner(
        private_root: &Path,
        seal: Option<Arc<dyn InboxReceiptSeal>>,
    ) -> Result<Self, TransferError> {
        check_dir(private_root)?;
        let root = private_root.canonicalize().map_err(storage)?;
        Ok(Self {
            root,
            verification: Mutex::new(()),
            seal,
        })
    }

    pub fn storage_directory(&self) -> &Path {
        &self.root
    }

    /// Reopen a known receipt after process restart. Corrupted or incomplete
    /// records never become completion events. A whole-file check is O(file size)
    /// with constant memory and belongs on an I/O worker, not a UI/event pump.
    pub fn verified_receipt(
        &self,
        key: TransferKey,
    ) -> Result<VerifiedInboxReceipt, TransferError> {
        let _job = self
            .verification
            .try_lock()
            .map_err(|_| ErrorCode::Conflict)?;
        let (dir, record) = self.read_record(key)?;
        verify_payload(&dir.join(CONTENT), &record.offer)?;
        Ok(VerifiedInboxReceipt(record))
    }

    /// Bounded, inert UTF-8 display for explicitly chosen text receipts.
    /// Only the same-open bytes matching the sealed length and digest leave the inbox.
    pub fn verified_text_preview(&self, key: TransferKey) -> Result<Option<String>, TransferError> {
        let _job = self
            .verification
            .try_lock()
            .map_err(|_| ErrorCode::Conflict)?;
        let (dir, record) = self.read_record(key)?;
        let offer = &record.offer;
        let supported = Path::new(&offer.name)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|ext| {
                ["txt", "text", "md", "csv", "tsv", "log"]
                    .iter()
                    .any(|allowed| ext.eq_ignore_ascii_case(allowed))
            });
        if !supported || offer.size_bytes > TEXT_PREVIEW_BYTES {
            return Ok(None);
        }
        let path = dir.join(CONTENT);
        regular(&path)?;
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_FLAG_OPEN_REPARSE_POINT: never follow a substituted final entry.
            options.custom_flags(0x0020_0000);
        }
        let file = options.open(path).map_err(storage)?;
        let meta = file.metadata().map_err(storage)?;
        if !meta.is_file() || redirected(&meta) || meta.len() != offer.size_bytes {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        let mut bytes = Vec::new();
        file.take(TEXT_PREVIEW_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(storage)?;
        if bytes.len() as u64 != offer.size_bytes
            || format!("{:x}", Sha256::digest(&bytes)) != offer.sha256
        {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        Ok(String::from_utf8(bytes).ok().filter(|text| {
            !text
                .chars()
                .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
        }))
    }

    /// Deliberate local save. The native chooser, not the sender or webview,
    /// supplies the destination. No replace and no open/launch after saving.
    pub fn save_verified_copy(
        &self,
        key: TransferKey,
        selected: &Path,
    ) -> Result<(), TransferError> {
        self.save_verified_copy_guarded(key, selected, || true)
    }

    /// Contextual adapters supply a final fail-closed native authorization
    /// check. A refused guard must never publish the verified staged bytes.
    pub fn save_verified_copy_guarded(
        &self,
        key: TransferKey,
        selected: &Path,
        authorize_commit: impl FnOnce() -> bool,
    ) -> Result<(), TransferError> {
        let _job = self
            .verification
            .try_lock()
            .map_err(|_| ErrorCode::Conflict)?;
        let (source, record) = self.read_record(key)?;
        let parent = selected.parent().ok_or(ErrorCode::InvalidRequest)?;
        let name = selected.file_name().ok_or(ErrorCode::InvalidRequest)?;
        if !selected.is_absolute() {
            return Err(ErrorCode::InvalidRequest.into());
        }
        check_dir(parent)?;
        let parent = parent.canonicalize().map_err(storage)?;
        if parent.starts_with(&self.root) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let destination = parent.join(name);
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(ErrorCode::Conflict.into());
        }
        let mut stage = Builder::new()
            .prefix(".aerift-saving-")
            .tempfile_in(&parent)
            .map_err(storage)?;
        stream_verified_payload(&source.join(CONTENT), &record.offer, &mut stage)?;
        stage.as_file().sync_all().map_err(storage)?;
        if !authorize_commit() {
            return Err(ErrorCode::Cancelled.into());
        }
        stage.persist_noclobber(destination).map_err(|err| {
            if err.error.kind() == io::ErrorKind::AlreadyExists {
                ErrorCode::Conflict.into()
            } else {
                storage(err.error)
            }
        })?;
        Ok(())
    }

    /// Browse recovery candidates without hashing every payload. Call
    /// verified_receipt before claiming restored data is still intact.
    pub fn recovery_candidates(&self, query: &str) -> Result<InboxPage, TransferError> {
        check_dir(&self.root)?;
        let filter = query.trim().to_lowercase();
        if filter.len() > 256 {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let mut entries = Vec::new();
        let mut truncated = false;
        for (index, candidate) in fs::read_dir(&self.root).map_err(storage)?.enumerate() {
            if index >= MAX_SCAN {
                truncated = true;
                break;
            }
            let candidate = candidate.map_err(storage)?;
            let name = candidate.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some((peer, id)) = name.split_once('-') else {
                continue;
            };
            let (Ok(peer), Some(id)) = (peer.parse(), crate::parse_id(id)) else {
                continue;
            };
            let key = TransferKey { peer, id };
            let Ok((dir, record)) = self.read_record(key) else {
                continue;
            };
            if !regular(&dir.join(CONTENT)).is_ok_and(|meta| meta.len() == record.offer.size_bytes)
                || !record.offer.name.to_lowercase().contains(&filter)
            {
                continue;
            }
            let received_at_unix_ms = self.receipt_time(&dir, &record);
            entries.push(InboxCandidate {
                peer,
                id,
                name: record.offer.name,
                size_bytes: record.offer.size_bytes,
                requested_destination: record.requested_destination,
                received_at_unix_ms,
            });
        }
        entries.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(InboxPage { entries, truncated })
    }

    fn read_record(&self, key: TransferKey) -> Result<(PathBuf, Record), TransferError> {
        let dir = self.entry(key);
        check_dir(&self.root)?;
        check_dir(&dir)?;
        let marker = dir.join(MARKER);
        let meta = regular(&marker)?;
        let max = if self.seal.is_some() {
            SEALED_RECEIPT_BYTES
        } else {
            RECEIPT_BYTES
        };
        if meta.len() > max {
            return Err(ErrorCode::StorageFailed.into());
        }
        let mut bytes = Vec::new();
        File::open(marker)
            .map_err(storage)?
            .take(max + 1)
            .read_to_end(&mut bytes)
            .map_err(storage)?;
        if bytes.is_empty() || bytes.len() as u64 > max {
            return Err(ErrorCode::StorageFailed.into());
        }
        if let Some(seal) = &self.seal {
            bytes = seal.unseal(&bytes).map_err(storage)?;
        }
        if bytes.is_empty() || bytes.len() as u64 > RECEIPT_BYTES {
            return Err(ErrorCode::StorageFailed.into());
        }
        let record: Record =
            serde_json::from_slice(&bytes).map_err(|_| ErrorCode::StorageFailed)?;
        record.offer.validate()?;
        if record.version != VERSION || record.peer != key.peer || record.offer.id != key.id {
            return Err(ErrorCode::StorageFailed.into());
        }
        Ok((dir, record))
    }

    fn receipt_time(&self, dir: &Path, record: &Record) -> Option<u64> {
        let seal = self.seal.as_ref()?;
        let path = dir.join(CLOCK_MARKER);
        let metadata = regular(&path).ok()?;
        if metadata.len() > SEALED_RECEIPT_BYTES {
            return None;
        }
        let mut bytes = Vec::new();
        File::open(path)
            .ok()?
            .take(SEALED_RECEIPT_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.is_empty() || bytes.len() as u64 > SEALED_RECEIPT_BYTES {
            return None;
        }
        let body = seal.unseal(&bytes).ok()?;
        if body.is_empty() || body.len() as u64 > RECEIPT_BYTES {
            return None;
        }
        let clock: ReceiptClock = serde_json::from_slice(&body).ok()?;
        (clock.format == CLOCK_FORMAT
            && clock.peer == record.peer
            && clock.id == record.offer.id
            && clock.digest == record.offer.sha256
            && clock.size_bytes == record.offer.size_bytes
            && valid_clock(clock.received_at_unix_ms))
        .then_some(clock.received_at_unix_ms)
    }

    fn write_clock(&self, dir: &Path, key: TransferKey, offer: &Offer) -> Option<()> {
        let seal = self.seal.as_ref()?;
        let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
        let received_at_unix_ms = u64::try_from(elapsed.as_millis()).ok()?;
        if !valid_clock(received_at_unix_ms) {
            return None;
        }
        let body = serde_json::to_vec(&ReceiptClock {
            format: CLOCK_FORMAT.to_owned(),
            peer: key.peer,
            id: key.id,
            digest: offer.sha256.clone(),
            size_bytes: offer.size_bytes,
            received_at_unix_ms,
        })
        .ok()?;
        if body.is_empty() || body.len() as u64 > RECEIPT_BYTES {
            return None;
        }
        let sealed = seal.seal(&body).ok()?;
        if sealed.is_empty() || sealed.len() as u64 > SEALED_RECEIPT_BYTES {
            return None;
        }
        let mut stage = Builder::new().tempfile_in(dir).ok()?;
        stage.write_all(&sealed).ok()?;
        stage.flush().ok()?;
        stage.as_file().sync_all().ok()?;
        stage.persist_noclobber(dir.join(CLOCK_MARKER)).ok()?;
        Some(())
    }

    fn entry(&self, key: TransferKey) -> PathBuf {
        self.root.join(format!("{}-{}", key.peer, key.id))
    }

    pub(crate) fn tempfile(&self) -> Result<NamedTempFile, TransferError> {
        check_dir(&self.root)?;
        Builder::new()
            .prefix(".aerift-incoming-")
            .tempfile_in(&self.root)
            .map_err(storage)
    }

    /// Called only from the existing receiver publication gate after the server
    /// has checked full byte length, digest and cancellation. The receipt marker
    /// is published last; an interrupted transaction is never restorable.
    pub(crate) fn publish(
        &self,
        key: TransferKey,
        offer: &Offer,
        requested_destination: FrozenDelivery,
        file: NamedTempFile,
    ) -> Result<PathBuf, TransferError> {
        check_dir(&self.root)?;
        let dir = self.entry(key);
        fs::create_dir(&dir).map_err(storage)?;
        let saved_path = dir.join(CONTENT);
        let published = (|| {
            let mut marker = Builder::new().tempfile_in(&dir).map_err(storage)?;
            let body = serde_json::to_vec(&Record {
                version: VERSION,
                peer: key.peer,
                offer: offer.clone(),
                requested_destination,
            })
            .map_err(|_| ErrorCode::StorageFailed)?;
            if body.is_empty() || body.len() as u64 > RECEIPT_BYTES {
                return Err(ErrorCode::StorageFailed.into());
            }
            let body = match &self.seal {
                Some(seal) => seal.seal(&body).map_err(storage)?,
                None => body,
            };
            if body.is_empty() || body.len() as u64 > SEALED_RECEIPT_BYTES {
                return Err(ErrorCode::StorageFailed.into());
            }
            marker.write_all(&body).map_err(storage)?;
            marker.flush().map_err(storage)?;
            marker.as_file().sync_all().map_err(storage)?;
            file.persist_noclobber(&saved_path)
                .map_err(|error| storage(error.error))?;
            // This optional, separately bound metadata stays invisible until the
            // original strict v1 receipt is published. Failure leaves no guessed date.
            let _ = self.write_clock(&dir, key, offer);
            sync_directory(&dir)?;
            sync_directory(&self.root)?;
            marker
                .persist_noclobber(dir.join(MARKER))
                .map_err(|error| storage(error.error))?;
            sync_directory(&dir)?;
            Ok::<(), TransferError>(())
        })();
        if published.is_err() {
            // Remove only exact names we own inside the directory exclusively
            // created by this transaction, never recursively delete anything.
            let _ = fs::remove_file(dir.join(MARKER));
            let _ = fs::remove_file(dir.join(CLOCK_MARKER));
            let _ = fs::remove_file(&saved_path);
            let _ = fs::remove_dir(&dir);
        }
        published.map(|()| saved_path)
    }
}

fn verify_payload(path: &Path, offer: &Offer) -> Result<(), TransferError> {
    stream_verified_payload(path, offer, &mut io::sink())
}

fn stream_verified_payload(
    path: &Path,
    offer: &Offer,
    out: &mut impl Write,
) -> Result<(), TransferError> {
    if regular(path)?.len() != offer.size_bytes {
        return Err(ErrorCode::IntegrityFailed.into());
    }
    let mut file = File::open(path)
        .map_err(storage)?
        .take(offer.size_bytes.saturating_add(1));
    let mut hash = Sha256::new();
    let mut observed = 0;
    let mut buffer = vec![0u8; crate::model::BUFFER_SIZE];
    loop {
        let size = file.read(&mut buffer).map_err(storage)?;
        if size == 0 {
            break;
        }
        observed += size as u64;
        if observed > offer.size_bytes {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        hash.update(&buffer[..size]);
        out.write_all(&buffer[..size]).map_err(storage)?;
    }
    if observed != offer.size_bytes || format!("{:x}", hash.finalize()) != offer.sha256 {
        return Err(ErrorCode::IntegrityFailed.into());
    }
    Ok(())
}

fn check_dir(path: &Path) -> Result<(), TransferError> {
    let metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !metadata.is_dir() || redirected(&metadata) {
        return Err(ErrorCode::StorageFailed.into());
    }
    Ok(())
}

fn regular(path: &Path) -> Result<Metadata, TransferError> {
    let metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !metadata.is_file() || redirected(&metadata) {
        return Err(ErrorCode::StorageFailed.into());
    }
    Ok(metadata)
}

fn redirected(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT, including symlinks and junctions.
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn sync_directory(path: &Path) -> Result<(), TransferError> {
    // Windows process-restart recovery uses the synchronized data and marker
    // files; power-loss durability of Windows directory metadata is not claimed.
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(storage)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn storage(_: io::Error) -> TransferError {
    ErrorCode::StorageFailed.into()
}

#[cfg(test)]
mod receipt_seal_tests {
    use super::*;

    use std::collections::BTreeMap;

    // Opaque test-only handles; not a replacement for the native seal provider.
    #[derive(Default)]
    struct TestSeal(Mutex<BTreeMap<Vec<u8>, Vec<u8>>>);
    impl InboxReceiptSeal for TestSeal {
        fn seal(&self, bytes: &[u8]) -> io::Result<Vec<u8>> {
            let handle = Sha256::digest(bytes).to_vec();
            self.0.lock().unwrap().insert(handle.clone(), bytes.to_vec());
            Ok(handle)
        }
        fn unseal(&self, bytes: &[u8]) -> io::Result<Vec<u8>> {
            self.0
                .lock()
                .unwrap()
                .get(bytes)
                .cloned()
                .ok_or(io::ErrorKind::InvalidData.into())
        }
    }

    #[test]
    fn restored_native_receipt_requires_its_seal_and_payload() {
        let temp = tempfile::tempdir().unwrap();
        let protector = std::sync::Arc::new(TestSeal::default());
        let inbox = Inbox::open_sealed(temp.path(), protector.clone()).unwrap();
        let key = TransferKey {
            peer: hex_peer(),
            id: uuid::Uuid::new_v4(),
        };
        let offer = Offer {
            id: key.id,
            name: "portable-receipt.txt".into(),
            size_bytes: 5,
            sha256: format!("{:x}", Sha256::digest(b"proof")),
        };
        let mut payload = inbox.tempfile().unwrap();
        payload.write_all(b"proof").unwrap();
        inbox
            .publish(key, &offer, FrozenDelivery::Inbox, payload)
            .unwrap();
        drop(inbox);
        let opened = Inbox::open_sealed(temp.path(), protector).unwrap();
        let proof = opened.verified_receipt(key).unwrap();
        assert_eq!(proof.offer(), &offer);
        assert_eq!(proof.peer(), key.peer);
        let path = opened.entry(key);
        let forged = Offer {
            sha256: format!("{:x}", Sha256::digest(b"false")),
            ..offer
        };
        fs::write(path.join(CONTENT), b"false").unwrap();
        assert!(opened.verified_receipt(key).is_err());
        fs::write(
            path.join(MARKER),
            serde_json::to_vec(&Record {
                version: VERSION,
                peer: key.peer,
                offer: forged,
                requested_destination: FrozenDelivery::Inbox,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(opened.verified_receipt(key).is_err());
        assert!(opened.recovery_candidates("").unwrap().entries.is_empty());
    }

    #[test]
    fn dated_receipts_round_trip_and_sealed_legacy_receipts_stay_undated() {
        let temp = tempfile::tempdir().unwrap();
        let protector = Arc::new(TestSeal::default());
        let inbox = Inbox::open_sealed(temp.path(), protector.clone()).unwrap();
        let key = TransferKey {
            peer: hex_peer(),
            id: uuid::Uuid::new_v4(),
        };
        let offer = Offer {
            id: key.id,
            name: "dated.txt".into(),
            size_bytes: 5,
            sha256: format!("{:x}", Sha256::digest(b"proof")),
        };
        let mut payload = inbox.tempfile().unwrap();
        payload.write_all(b"proof").unwrap();
        inbox
            .publish(key, &offer, FrozenDelivery::Inbox, payload)
            .unwrap();
        let list = inbox.recovery_candidates("").unwrap();
        let time = list.entries[0].received_at_unix_ms.unwrap();
        assert!(time >= 1_577_836_800_000);
        let value = serde_json::to_value(&list.entries[0]).unwrap();
        assert_eq!(value["receivedAtUnixMs"].as_u64(), Some(time));

        let dir = inbox.entry(key);
        let original = protector.unseal(&fs::read(dir.join(MARKER)).unwrap()).unwrap();
        let original: serde_json::Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(original.as_object().unwrap().len(), 4);
        assert!(!original.as_object().unwrap().contains_key("received_at_unix_ms"));

        // A time sidecar signed for a different receipt never supplies chronology.
        let forged = ReceiptClock {
            format: CLOCK_FORMAT.to_owned(),
            peer: key.peer,
            id: uuid::Uuid::new_v4(),
            digest: offer.sha256.clone(),
            size_bytes: offer.size_bytes,
            received_at_unix_ms: time,
        };
        let wrong = protector.seal(&serde_json::to_vec(&forged).unwrap()).unwrap();
        fs::write(dir.join(CLOCK_MARKER), wrong).unwrap();
        assert!(inbox.recovery_candidates("").unwrap().entries[0]
            .received_at_unix_ms
            .is_none());

        // Legacy releases stored only the original marker and payload.
        fs::remove_file(dir.join(CLOCK_MARKER)).unwrap();
        assert!(inbox.verified_receipt(key).is_ok());
        let list = inbox.recovery_candidates("").unwrap();
        assert_eq!(list.entries[0].received_at_unix_ms, None);
        assert!(serde_json::to_value(&list.entries[0])
            .unwrap()
            .get("receivedAtUnixMs")
            .is_none());
    }

    #[test]
    fn text_preview_requires_the_exact_verified_bytes_and_never_returns_other_types() {
        let temp = tempfile::tempdir().unwrap();
        let protector = Arc::new(TestSeal::default());
        let inbox = Inbox::open_sealed(temp.path(), protector).unwrap();
        let key = TransferKey {
            peer: hex_peer(),
            id: uuid::Uuid::new_v4(),
        };
        let body = b"<script>not executable in the preview</script>";
        let mut offer = Offer {
            id: key.id,
            name: "plain.txt".into(),
            size_bytes: body.len() as u64,
            sha256: format!("{:x}", Sha256::digest(body)),
        };
        let mut payload = inbox.tempfile().unwrap();
        payload.write_all(body).unwrap();
        inbox
            .publish(key, &offer, FrozenDelivery::Inbox, payload)
            .unwrap();
        assert_eq!(
            inbox.verified_text_preview(key).unwrap().as_deref(),
            Some(std::str::from_utf8(body).unwrap())
        );
        fs::write(inbox.entry(key).join(CONTENT), vec![b'x'; body.len()]).unwrap();
        assert!(inbox.verified_text_preview(key).is_err());

        let key = TransferKey {
            peer: hex_peer(),
            id: uuid::Uuid::new_v4(),
        };
        offer.id = key.id;
        offer.name = "not-a-text-file.html".into();
        let mut payload = inbox.tempfile().unwrap();
        payload.write_all(body).unwrap();
        inbox
            .publish(key, &offer, FrozenDelivery::Inbox, payload)
            .unwrap();
        assert!(inbox.verified_text_preview(key).unwrap().is_none());
    }

    fn hex_peer() -> PeerId {
        "123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0"
            .parse()
            .unwrap()
    }
}

#[cfg(test)]
mod inbox_export_tests {
    use super::*;

    #[test]
    fn saved_copy_requires_valid_payload_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let inbox = Inbox::open(root.path()).unwrap();
        let key = TransferKey {
            peer: "123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0"
                .parse()
                .unwrap(),
            id: uuid::Uuid::new_v4(),
        };
        let payload = b"fixture";
        let offer = Offer {
            id: key.id,
            name: "sample.txt".into(),
            size_bytes: payload.len() as u64,
            sha256: format!("{:x}", Sha256::digest(payload)),
        };
        let mut incoming = inbox.tempfile().unwrap();
        incoming.write_all(payload).unwrap();
        inbox
            .publish(key, &offer, FrozenDelivery::Inbox, incoming)
            .unwrap();
        let selected = destination.path().join("chosen.txt");
        inbox.save_verified_copy(key, &selected).unwrap();
        assert_eq!(fs::read(&selected).unwrap(), payload);
        let revoked = destination.path().join("revoked");
        assert_eq!(
            inbox
                .save_verified_copy_guarded(key, &revoked, || false)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert!(!revoked.exists());
        fs::write(&selected, b"existing").unwrap();
        assert!(inbox.save_verified_copy(key, &selected).is_err());
        assert_eq!(fs::read(&selected).unwrap(), b"existing");
        assert!(
            inbox
                .save_verified_copy(key, &root.path().join("forbidden"))
                .is_err()
        );
        fs::write(inbox.entry(key).join(CONTENT), b"changed").unwrap();
        let other = destination.path().join("corruption_must_not_publish");
        assert!(inbox.save_verified_copy(key, &other).is_err());
        assert!(!other.exists());
        assert_eq!(destination.path().read_dir().unwrap().count(), 1);
    }
}

