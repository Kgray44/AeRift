//! Optional Ambient folder representation over the existing resumable file transport.
//! No folder path can be published merely by receiving an ordinary file.
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    Connector, ErrorCode, IncomingTransfer, Offer, Receiver, Sender, State, Status, TransferError,
    TransferKey,
    ambient::{
        CONTENT_BLOCK, FrozenCapture, ObjectManifest, Preview, ReceiverCapabilities,
        Representation, RiftObjectKind,
    },
    model::safe_name,
};

const MAGIC: &[u8] = b"AERIFTO1";
const NAME: &str = "AeRift-Folder.aerift";
const MAX_ENTRIES: usize = 1024;
const MAX_DEPTH: usize = 24;
const MAX_HEADER: usize = 1024 * 1024;
const MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const BUFFER: usize = 64 * 1024;

#[derive(Clone)]
pub struct PreparedFolder(Arc<FolderSource>);

struct FolderSource {
    capture: Arc<FrozenCapture>,
    header: Vec<u8>,
    spans: Vec<Span>,
    size: u64,
    sha256: String,
}

struct Span {
    index: usize,
    start: u64,
    end: u64,
}

pub struct StagedFolder {
    _private_root: TempDir,
    folder: PathBuf,
}

impl StagedFolder {
    /// Private verified tree. Keep this handle alive through explicit local export.
    /// It is still staged and must not be reported as published to a destination.
    pub fn path(&self) -> &Path {
        &self.folder
    }
}

/// Explicitly negotiate the existing Ambient representation; no automatic
/// downgrade or per-platform transport can send this object.
impl PreparedFolder {
    /// UI-safe root title and exact prepared transport size, without a source path.
    pub fn progress_manifest(&self) -> (&str, u64) {
        (&self.0.capture.entries()[0].manifest().title, self.0.size)
    }

    /// Explicit host capability; never falls back to a legacy file sender.
    pub async fn send_over<C: Connector>(
        &self,
        sender: &Sender<C>,
        id: Uuid,
        capability: ReceiverCapabilities,
        cancel: CancellationToken,
        progress: impl Fn(Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        if !capability.object_manifest_v1 {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        sender
            .send_folder_with_id(id, self.clone(), cancel, progress)
            .await
    }

    pub(crate) fn offer(&self, id: Uuid) -> Result<Offer, TransferError> {
        let offer = Offer {
            id,
            name: NAME.into(),
            size_bytes: self.0.size,
            sha256: self.0.sha256.clone(),
        };
        offer.validate()?;
        Ok(offer)
    }

    /// Read one authenticated checkpoint from the virtual envelope. Each
    /// touched source block is validated in full even for a short overlap.
    pub(crate) fn block(&self, offset: u64, length: usize) -> Result<Vec<u8>, TransferError> {
        let source = &self.0;
        let end = offset
            .checked_add(length as u64)
            .filter(|end| *end <= source.size)
            .ok_or(ErrorCode::InvalidRequest)?;
        if length > crate::RESUMABLE_CHUNK_SIZE {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let mut out = Vec::with_capacity(length);
        let header_end = source.header.len() as u64;
        let mut cursor = offset;
        if cursor < header_end {
            let till = end.min(header_end);
            out.extend_from_slice(&source.header[cursor as usize..till as usize]);
            cursor = till;
        }
        let mut verified = Vec::new();
        let first = source.spans.partition_point(|span| span.end <= cursor);
        for span in &source.spans[first..] {
            if cursor >= end {
                break;
            }
            let entry = &source.capture.entries()[span.index];
            let (mut file, hashes) = entry
                .open_frozen_file()
                .map_err(|_| ErrorCode::IntegrityFailed)?;
            let relative = cursor - span.start;
            let mut aligned = relative / CONTENT_BLOCK as u64 * CONTENT_BLOCK as u64;
            file.seek(SeekFrom::Start(aligned))
                .map_err(|_| ErrorCode::IntegrityFailed)?;
            let file_end = span.end.min(end);
            while cursor < file_end {
                let size = (entry.manifest().size - aligned).min(CONTENT_BLOCK as u64) as usize;
                verified.resize(size, 0);
                file.read_exact(&mut verified)
                    .map_err(|_| ErrorCode::IntegrityFailed)?;
                let actual: [u8; 32] = Sha256::digest(&verified).into();
                if hashes.get((aligned / CONTENT_BLOCK as u64) as usize) != Some(&actual) {
                    return Err(ErrorCode::IntegrityFailed.into());
                }
                let position = span.start + aligned;
                let till = file_end.min(position + size as u64);
                out.extend_from_slice(
                    &verified[(cursor - position) as usize..(till - position) as usize],
                );
                cursor = till;
                aligned += size as u64;
            }
        }
        if out.len() != length {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        Ok(out)
    }
}

/// Index and hash an already frozen directory without materializing an archive.
/// Run off the UI thread; memory is bounded by the canonical header, index and
/// Ambient's block verifier. Retained hash metadata uses one 32-byte digest
/// per frozen file block; no full payload copy is retained.
pub fn prepare_folder(
    capture: Arc<FrozenCapture>,
    cancel: &CancellationToken,
) -> Result<PreparedFolder, TransferError> {
    let allowed = || !cancel.is_cancelled();
    guard(&allowed)?;
    if capture.kind != RiftObjectKind::Directory
        || capture.negotiate(ReceiverCapabilities {
            object_manifest_v1: true,
        }) != Ok(Representation::ManifestV1)
    {
        return Err(ErrorCode::UnsupportedVersion.into());
    }
    if capture.entries().len() > MAX_ENTRIES {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let entries: Vec<_> = capture
        .entries()
        .iter()
        .map(|entry| entry.manifest().clone())
        .collect();
    let payload = validate(&entries)?;
    let encoded = serde_json::to_vec(&entries).map_err(|_| ErrorCode::InvalidRequest)?;
    if encoded.is_empty() || encoded.len() > MAX_HEADER {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let mut header = MAGIC.to_vec();
    header.extend((encoded.len() as u32).to_be_bytes());
    header.extend(encoded);
    let size = payload
        .checked_add(header.len() as u64)
        .filter(|size| *size <= MAX_BYTES)
        .ok_or(ErrorCode::InvalidRequest)?;
    let mut spans = Vec::new();
    let mut position = header.len() as u64;
    let mut sha = Sha256::new();
    sha.update(&header);
    let mut digest_sink = DigestSink(&mut sha);
    let mut buffer = vec![0; BUFFER];
    for (index, entry) in capture.entries().iter().enumerate() {
        if entry.manifest().kind != RiftObjectKind::File {
            continue;
        }
        let mut reader = entry
            .open_verified()
            .map_err(|_| ErrorCode::IntegrityFailed)?;
        verify_copy(
            &mut reader,
            &mut digest_sink,
            entry.manifest(),
            &mut buffer,
            &allowed,
        )?;
        if reader
            .read(&mut [0])
            .map_err(|_| ErrorCode::IntegrityFailed)?
            != 0
        {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        let end = position + entry.manifest().size;
        if end != position {
            spans.push(Span {
                index,
                start: position,
                end,
            });
        }
        position = end;
    }
    guard(&allowed)?;
    Ok(PreparedFolder(Arc::new(FolderSource {
        capture,
        header,
        spans,
        size,
        sha256: format!("{:x}", sha.finalize()),
    })))
}

struct DigestSink<'a>(&'a mut Sha256);
impl Write for DigestSink<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.0.update(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Receiver {
    /// Requires the caller's explicit folder capability and a completed v2
    /// record owned by the authenticated transfer key. Legacy raw transfers
    /// do not acquire folder authority from a name, extension, or magic.
    pub fn stage_resumable_folder(
        &self,
        key: TransferKey,
        capability: ReceiverCapabilities,
        scratch: &Path,
        cancel: &CancellationToken,
    ) -> Result<StagedFolder, TransferError> {
        if !capability.object_manifest_v1 {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        let (receipt, trust) = self.completed_resumable(key)?;
        stage_verified_folder(&receipt, scratch, || {
            !cancel.is_cancelled() && !trust.is_cancelled()
        })
    }
}

/// Decode only a completed, authenticated v2 object receipt whose host has
/// explicitly selected the folder representation. No installed receiver invokes
/// this automatically. Returned data stays in the private, delete-on-drop tree.
fn stage_verified_folder(
    receipt: &IncomingTransfer,
    scratch: &Path,
    allowed: impl Fn() -> bool,
) -> Result<StagedFolder, TransferError> {
    guard(&allowed)?;
    validate_completed_receipt(receipt)?;
    let path = receipt
        .saved_path
        .as_deref()
        .ok_or(ErrorCode::StorageFailed)?;
    if !path.symlink_metadata().map_err(storage)?.is_file() {
        return Err(ErrorCode::StorageFailed.into());
    }
    let file = File::open(path).map_err(storage)?;
    if !file.metadata().map_err(storage)?.is_file()
        || file.metadata().map_err(storage)?.len() != receipt.offer.size_bytes
    {
        return Err(ErrorCode::IntegrityFailed.into());
    }
    let (mut source, entries, _) = read_envelope_manifest(file, receipt)?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".aerift-verified-folder-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    let private_root = builder.tempdir_in(scratch).map_err(storage)?;
    let mut buffer = vec![0_u8; BUFFER];
    for entry in &entries {
        guard(&allowed)?;
        // Every component was checked as an indivisible portable leaf; the
        // parents were validated before writing and exist only in our new stage.
        let target = entry
            .capture_path
            .iter()
            .fold(private_root.path().to_owned(), |name, item| name.join(item));
        if entry.kind == RiftObjectKind::Directory {
            fs::create_dir(target).map_err(storage)?;
        } else {
            let mut writer = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(storage)?;
            verify_copy(&mut source, &mut writer, entry, &mut buffer, &allowed)?;
            writer.sync_all().map_err(storage)?;
        }
    }
    finish_envelope(source, receipt)?;
    guard(&allowed)?;
    Ok(StagedFolder {
        folder: private_root.path().join(&entries[0].title),
        _private_root: private_root,
    })
}

fn validate_completed_receipt(receipt: &IncomingTransfer) -> Result<(), TransferError> {
    receipt.offer.validate()?;
    if receipt.offer.size_bytes > MAX_BYTES
        || receipt.status.state != State::Completed
        || receipt.status.bytes_transferred != receipt.offer.size_bytes
        || receipt.key.id != receipt.offer.id
        || receipt.offer.name != NAME
    {
        return Err(ErrorCode::Conflict.into());
    }
    Ok(())
}

fn read_envelope_manifest<R: Read>(
    file: R,
    receipt: &IncomingTransfer,
) -> Result<(DigestReader<R>, Vec<ObjectManifest>, Vec<u8>), TransferError> {
    let mut source = DigestReader {
        reader: file,
        digest: Sha256::new(),
    };
    let mut magic = [0; MAGIC.len()];
    let mut header_length = [0; 4];
    source
        .read_exact(&mut magic)
        .and_then(|()| source.read_exact(&mut header_length))
        .map_err(|_| ErrorCode::IntegrityFailed)?;
    if magic != MAGIC {
        return Err(ErrorCode::UnsupportedVersion.into());
    }
    let header_size = u32::from_be_bytes(header_length) as usize;
    if header_size == 0 || header_size > MAX_HEADER {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let mut header = vec![0_u8; header_size];
    source
        .read_exact(&mut header)
        .map_err(|_| ErrorCode::IntegrityFailed)?;
    let entries: Vec<ObjectManifest> =
        serde_json::from_slice(&header).map_err(|_| ErrorCode::InvalidRequest)?;
    if serde_json::to_vec(&entries).map_err(|_| ErrorCode::InvalidRequest)? != header {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let total = validate(&entries)?;
    if total.checked_add((MAGIC.len() + 4 + header_size) as u64) != Some(receipt.offer.size_bytes) {
        return Err(ErrorCode::IntegrityFailed.into());
    }

    let mut frame = Vec::with_capacity(MAGIC.len() + header_length.len() + header.len());
    frame.extend(magic);
    frame.extend(header_length);
    frame.extend(header);
    Ok((source, entries, frame))
}

fn finish_envelope<R: Read>(
    mut source: DigestReader<R>,
    receipt: &IncomingTransfer,
) -> Result<(), TransferError> {
    let mut extra = [0_u8; 1];
    if source
        .read(&mut extra)
        .map_err(|_| ErrorCode::IntegrityFailed)?
        != 0
        || format!("{:x}", source.digest.finalize()) != receipt.offer.sha256
    {
        return Err(ErrorCode::IntegrityFailed.into());
    }
    Ok(())
}

fn validate(entries: &[ObjectManifest]) -> Result<u64, TransferError> {
    let Some(root) = entries
        .first()
        .filter(|entry| entry.kind == RiftObjectKind::Directory && entry.capture_path.len() == 1)
    else {
        return Err(ErrorCode::InvalidRequest.into());
    };
    if entries.len() > MAX_ENTRIES {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let mut nodes = HashMap::with_capacity(entries.len());
    let mut collision = HashSet::with_capacity(entries.len());
    let mut total = 0_u64;
    for (index, entry) in entries.iter().enumerate() {
        let valid_path = !entry.capture_path.is_empty()
            && entry.capture_path.len() <= MAX_DEPTH
            && entry
                .capture_path
                .iter()
                .all(|part| part.is_ascii() && safe_name(part))
            && entry.capture_path.last() == Some(&entry.title)
            && entry.capture_path.first() == Some(&root.title);
        if !valid_path || entry.media_type.is_some() {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let path = entry.capture_path.as_slice();
        if index != 0
            && (path.len() < 2
                || nodes.get(&path[..path.len() - 1]) != Some(&RiftObjectKind::Directory))
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        if !collision.insert(
            path.iter()
                .map(|name| name.to_lowercase())
                .collect::<Vec<_>>(),
        ) || nodes.insert(path, entry.kind).is_some()
        {
            return Err(ErrorCode::Conflict.into());
        }
        match entry.kind {
            RiftObjectKind::Directory
                if entry.preview == Preview::Folder
                    && entry.size == 0
                    && entry.sha256.is_none() => {}
            RiftObjectKind::File
                if entry.preview == Preview::Filename
                    && entry.sha256.as_deref().is_some_and(valid_digest) =>
            {
                total = total
                    .checked_add(entry.size)
                    .filter(|&bytes| bytes <= MAX_BYTES)
                    .ok_or(ErrorCode::InvalidRequest)?;
            }
            _ => return Err(ErrorCode::UnsupportedVersion.into()),
        }
    }
    Ok(total)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn verify_copy(
    mut source: impl Read,
    mut sink: impl Write,
    entry: &ObjectManifest,
    buffer: &mut [u8],
    allowed: &impl Fn() -> bool,
) -> Result<(), TransferError> {
    let mut remaining = entry.size;
    let mut sha = Sha256::new();
    while remaining != 0 {
        guard(allowed)?;
        let len = remaining.min(buffer.len() as u64) as usize;
        source
            .read_exact(&mut buffer[..len])
            .map_err(|_| ErrorCode::IntegrityFailed)?;
        sink.write_all(&buffer[..len]).map_err(storage)?;
        sha.update(&buffer[..len]);
        remaining -= len as u64;
    }
    let actual = format!("{:x}", sha.finalize());
    if entry.sha256.as_deref() == Some(actual.as_str()) {
        Ok(())
    } else {
        Err(ErrorCode::IntegrityFailed.into())
    }
}

fn guard(allowed: &impl Fn() -> bool) -> Result<(), TransferError> {
    if allowed() {
        Ok(())
    } else {
        Err(ErrorCode::Cancelled.into())
    }
}

struct DigestReader<T> {
    reader: T,
    digest: Sha256,
}
impl<T: Read> Read for DigestReader<T> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.reader.read(bytes)?;
        self.digest.update(&bytes[..count]);
        Ok(count)
    }
}
fn storage(_: impl Sized) -> TransferError {
    ErrorCode::StorageFailed.into()
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ambient::{Candidate, CaptureContext, CaptureLimits, freeze};
    fn directory(path: &[&str]) -> ObjectManifest {
        ObjectManifest {
            kind: RiftObjectKind::Directory,
            title: path.last().unwrap().to_string(),
            capture_path: path.iter().map(|item| (*item).to_owned()).collect(),
            media_type: None,
            preview: Preview::Folder,
            size: 0,
            sha256: None,
        }
    }

    #[test]
    fn blocks_portable_aliases_and_conflicting_hierarchies() {
        let first = directory(&["Root"]);
        for denied in [
            "..",
            "/absolute",
            "\\server",
            "C:drive",
            "device:ads",
            "CON",
            "COM1.txt",
            "a.",
            "é",
            "é",
        ] {
            assert!(
                validate(&[first.clone(), directory(&["Root", denied])]).is_err(),
                "{denied}"
            );
        }
        assert!(
            validate(&[
                first.clone(),
                directory(&["Root", "same"]),
                directory(&["Root", "SAME"])
            ])
            .is_err()
        );
        assert!(validate(&[first.clone(), directory(&["Root", "missing", "child"])]).is_err());
        assert!(validate(&[first, directory(&["Different", "child"])]).is_err());
    }

    #[test]
    fn malformed_header_and_cancel_do_not_leave_private_write_artifacts() {
        let sandbox = tempfile::tempdir().unwrap();
        let sink = sandbox.path().join("stage");
        fs::create_dir(&sink).unwrap();
        let fixture = sandbox.path().join("synthetic-envelope");
        let header: Vec<_> = vec![serde_json::json!({
            "kind": "directory", "title": "Root", "capture_path": ["Root"], "media_type": null,
            "preview": "folder", "size": 0, "sha256": null, "unrecognized_source_locator": "/redacted/example",
        })];
        let json = serde_json::to_vec(&header).unwrap();
        let mut bytes = MAGIC.to_vec();
        bytes.extend((json.len() as u32).to_be_bytes());
        bytes.extend(json);
        fs::write(&fixture, &bytes).unwrap();
        let id = Uuid::new_v4();
        let receipt = IncomingTransfer {
            key: TransferKey {
                id,
                peer: crate::PeerId::from_tls_leaf(b"synthetic"),
            },
            offer: crate::Offer {
                id,
                name: NAME.into(),
                size_bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
            },
            saved_path: Some(fixture),
            status: Status {
                state: State::Completed,
                bytes_transferred: bytes.len() as u64,
                error: None,
            },
        };
        assert!(stage_verified_folder(&receipt, &sink, || true).is_err());
        assert_eq!(
            stage_verified_folder(&receipt, &sink, || false)
                .err()
                .unwrap()
                .code,
            ErrorCode::Cancelled
        );
        assert_eq!(fs::read_dir(sink).unwrap().count(), 0);
    }

    #[test]
    fn frozen_tree_preserves_empty_dirs_and_only_verified_files() {
        let outer = tempfile::tempdir().unwrap();
        let input = outer.path().join("folder");
        let sink = outer.path().join("sink");
        std::fs::create_dir_all(input.join("empty")).unwrap();
        std::fs::create_dir_all(&sink).unwrap();
        std::fs::write(input.join("fixture.bin"), b"synthetic payload").unwrap();
        let capture = freeze(
            CaptureContext {
                explicit_selection: vec![Candidate::path(input)],
                ..Default::default()
            },
            CaptureLimits::default(),
        )
        .unwrap();
        let packed = prepare_folder(Arc::new(capture), &CancellationToken::new()).unwrap();
        let file = packed.block(0, packed.0.size as usize).unwrap();
        let fixture = outer.path().join("received");
        fs::write(&fixture, &file).unwrap();
        let id = Uuid::new_v4();
        let receipt = IncomingTransfer {
            key: crate::TransferKey {
                id,
                peer: crate::PeerId::from_tls_leaf(b"synthetic"),
            },
            offer: crate::Offer {
                id,
                name: NAME.into(),
                size_bytes: file.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&file)),
            },
            saved_path: Some(fixture),
            status: Status {
                state: State::Completed,
                bytes_transferred: file.len() as u64,
                error: None,
            },
        };
        let staged = stage_verified_folder(&receipt, &sink, || true).unwrap();
        assert!(staged.path().join("empty").is_dir());
        assert_eq!(
            std::fs::read(staged.path().join("fixture.bin")).unwrap(),
            b"synthetic payload"
        );
        assert!(!sink.join("folder").exists());
    }

    #[test]
    fn virtual_checkpoint_detects_mutation_after_preparation() {
        let outer = tempfile::tempdir().unwrap();
        let input = outer.path().join("folder");
        fs::create_dir(&input).unwrap();
        let file = input.join("fixture.bin");
        fs::write(&file, b"original payload").unwrap();
        let capture = freeze(
            CaptureContext {
                explicit_selection: vec![Candidate::path(input)],
                ..Default::default()
            },
            CaptureLimits::default(),
        )
        .unwrap();
        let prepared = prepare_folder(Arc::new(capture), &CancellationToken::new()).unwrap();
        let span = &prepared.0.spans[0];
        assert_eq!(prepared.block(span.start + 2, 4).unwrap(), b"igin");
        fs::write(&file, b"modified payload").unwrap();
        assert_eq!(
            prepared.block(span.start + 2, 4).unwrap_err().code,
            ErrorCode::IntegrityFailed
        );
    }

    #[test]
    fn unsafe_child_names_are_never_written_even_if_outer_digest_matches() {
        use crate::ambient::{ObjectManifest, Preview, RiftObjectKind};
        let root = ObjectManifest {
            kind: RiftObjectKind::Directory,
            title: "Root".into(),
            capture_path: vec!["Root".into()],
            media_type: None,
            preview: Preview::Folder,
            size: 0,
            sha256: None,
        };
        let mut child = root.clone();
        child.title = "..".into();
        child.capture_path.push("..".into());
        assert!(validate(&[root, child]).is_err());
    }
}

#[cfg(target_os = "linux")]
mod export;
#[cfg(target_os = "linux")]
pub use export::FolderExport;

pub mod admission;

// The Windows publisher requires a held native-picker/profile directory capability.
#[cfg(windows)]
mod windows_handles;
#[cfg(windows)]
pub use windows_handles::{
    PinnedDirectory as WindowsFolderDirectory, WindowsFolderExport,
    commit_verified_folder as commit_windows_folder,
};

#[cfg(all(windows, feature = "windows-folder-picker-qualification"))]
pub use windows_handles::{WindowsFolderReadEntry, WindowsFolderReadGrant, WindowsFolderReadPage};

pub mod admission_store;
