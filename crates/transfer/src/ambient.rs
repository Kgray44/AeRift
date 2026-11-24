//! Local-only capture contracts. A captured manifest conveys no transport authority.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Cursor, Read},
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RiftObjectKind {
    File,
    Directory,
    Image,
    Video,
    WebPage,
    Url,
    PlainText,
    RichText,
    Document,
    SpreadsheetRange,
    CodeSnippet,
    Clipboard,
    Note,
    Location,
    MediaReference,
    Collection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SourceApplication {
    /// Stable adapter-provided identifier, never a full path, window title, or command line.
    pub app_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureOrigin {
    ExplicitSelection,
    ExplicitTarget,
    ActiveContent,
    ActivePage,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Preview {
    Filename,
    Text,
    Media,
    Link,
    Folder,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ObjectManifest {
    pub kind: RiftObjectKind,
    pub title: String,
    pub capture_path: Vec<String>,
    pub media_type: Option<String>,
    pub preview: Preview,
    pub size: u64,
    pub sha256: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureError {
    NoSupportedObject,
    SensitiveContext,
    SourceUnavailable,
    SourceChanged,
    UnsupportedRepresentation,
    LimitExceeded,
    Cancelled,
}

// Deliberately non-Serialize and non-Debug; contents and paths are host capabilities.
pub struct Candidate {
    kind: RiftObjectKind,
    source: CandidateSource,
}
enum CandidateSource {
    Path(PathBuf),
    Inline {
        title: String,
        bytes: Vec<u8>,
        media_type: String,
    },
}
impl Candidate {
    pub fn path(path: PathBuf) -> Self {
        Self {
            kind: RiftObjectKind::File,
            source: CandidateSource::Path(path),
        }
    }
    pub fn file_as(kind: RiftObjectKind, path: PathBuf) -> Self {
        Self {
            kind,
            source: CandidateSource::Path(path),
        }
    }
    pub fn inline(
        kind: RiftObjectKind,
        title: impl Into<String>,
        bytes: Vec<u8>,
        media_type: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            source: CandidateSource::Inline {
                title: title.into(),
                bytes,
                media_type: media_type.into(),
            },
        }
    }
}

#[derive(Default)]
pub struct CaptureContext {
    pub source: Option<SourceApplication>,
    pub sensitive: bool,
    pub explicit_selection: Vec<Candidate>,
    pub explicit_targets: Vec<Candidate>,
    pub active_content: Option<Candidate>,
    pub active_page: Option<Candidate>,
}

pub trait ContextAdapter {
    /// Call on the platform adapter's owning thread; must not activate a window or mutate selection.
    fn snapshot(&self) -> Result<CaptureContext, CaptureError>;
}

#[derive(Clone, Copy)]
pub struct CaptureLimits {
    pub entries: usize,
    pub depth: usize,
    pub inline_bytes: usize,
    pub total_bytes: u64,
}
impl Default for CaptureLimits {
    fn default() -> Self {
        Self {
            entries: 1024,
            depth: 24,
            inline_bytes: 128 * 1024,
            total_bytes: 1 << 40,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReceiverCapabilities {
    pub object_manifest_v1: bool,
}
impl ReceiverCapabilities {
    /// Current shipped protocol supports one regular raw file.
    pub const V1: Self = Self {
        object_manifest_v1: false,
    };
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Representation {
    SingleRawFile,
    ManifestV1,
}

pub struct FrozenCapture {
    pub kind: RiftObjectKind,
    pub origin: CaptureOrigin,
    pub source: Option<SourceApplication>,
    entries: Vec<FrozenEntry>,
}
impl FrozenCapture {
    pub fn entries(&self) -> &[FrozenEntry] {
        &self.entries
    }
    pub fn negotiate(
        &self,
        receiver: ReceiverCapabilities,
    ) -> Result<Representation, CaptureError> {
        if self.entries.len() == 1
            && self.kind == RiftObjectKind::File
            && matches!(&self.entries[0].source, FrozenSource::File { .. })
        {
            Ok(Representation::SingleRawFile)
        } else if receiver.object_manifest_v1 {
            Ok(Representation::ManifestV1)
        } else {
            Err(CaptureError::UnsupportedRepresentation)
        }
    }
}
pub struct FrozenEntry {
    manifest: ObjectManifest,
    source: FrozenSource,
}
enum FrozenSource {
    File {
        path: PathBuf,
        digest: [u8; 32],
        stamp: Stamp,
        identity: FileIdentity,
    },
    Inline(Vec<u8>),
    Directory,
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct Stamp {
    size: u64,
    modified: SystemTime,
    #[cfg(unix)]
    identity: (u64, u64),
}
impl Stamp {
    fn from(metadata: &Metadata) -> Result<Self, CaptureError> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            size: metadata.len(),
            modified: metadata
                .modified()
                .map_err(|_| CaptureError::SourceUnavailable)?,
            #[cfg(unix)]
            identity: (metadata.dev(), metadata.ino()),
        })
    }
}

pub fn freeze(
    context: CaptureContext,
    limits: CaptureLimits,
) -> Result<FrozenCapture, CaptureError> {
    freeze_guarded(context, limits, || true)
}

pub fn freeze_guarded(
    context: CaptureContext,
    limits: CaptureLimits,
    allow: impl Fn() -> bool,
) -> Result<FrozenCapture, CaptureError> {
    if !allow() {
        return Err(CaptureError::Cancelled);
    }
    if context.sensitive {
        return Err(CaptureError::SensitiveContext);
    }
    let (origin, candidates) = if !context.explicit_selection.is_empty() {
        (CaptureOrigin::ExplicitSelection, context.explicit_selection)
    } else if !context.explicit_targets.is_empty() {
        (CaptureOrigin::ExplicitTarget, context.explicit_targets)
    } else if let Some(value) = context.active_content {
        (CaptureOrigin::ActiveContent, vec![value])
    } else if let Some(value) = context.active_page {
        (CaptureOrigin::ActivePage, vec![value])
    } else {
        return Err(CaptureError::NoSupportedObject);
    };
    let collection = candidates.len() > 1;
    let mut builder = Builder {
        limits,
        entries: Vec::new(),
        bytes: 0,
        inline: 0,
        allow: &allow,
        block: vec![0; 64 * 1024],
    };
    for candidate in candidates {
        if !allow() {
            return Err(CaptureError::Cancelled);
        }
        match candidate.source {
            CandidateSource::Path(path) => builder.path(&path, candidate.kind, &[])?,
            CandidateSource::Inline {
                title,
                bytes,
                media_type,
            } => {
                if matches!(
                    candidate.kind,
                    RiftObjectKind::File | RiftObjectKind::Directory | RiftObjectKind::Collection
                ) || !valid_name(&title)
                    || media_type.is_empty()
                    || media_type.len() > 128
                    || !media_type.bytes().all(|b| b.is_ascii_graphic())
                {
                    return Err(CaptureError::UnsupportedRepresentation);
                }
                builder.inline = builder
                    .inline
                    .checked_add(bytes.len())
                    .filter(|&n| n <= limits.inline_bytes)
                    .ok_or(CaptureError::LimitExceeded)?;
                builder.reserve(bytes.len() as u64)?;
                let digest = Sha256::digest(&bytes);
                builder.entries.push(FrozenEntry {
                    manifest: ObjectManifest {
                        kind: candidate.kind,
                        title: title.clone(),
                        capture_path: vec![title],
                        media_type: Some(media_type),
                        preview: preview(candidate.kind),
                        size: bytes.len() as u64,
                        sha256: Some(hex(&digest)),
                    },
                    source: FrozenSource::Inline(bytes),
                });
            }
        }
    }
    if !allow() {
        return Err(CaptureError::Cancelled);
    }
    let kind = if collection {
        RiftObjectKind::Collection
    } else {
        builder.entries[0].manifest.kind
    };
    Ok(FrozenCapture {
        kind,
        origin,
        source: context.source,
        entries: builder.entries,
    })
}

struct Builder<'a> {
    limits: CaptureLimits,
    entries: Vec<FrozenEntry>,
    bytes: u64,
    inline: usize,
    allow: &'a dyn Fn() -> bool,
    block: Vec<u8>,
}
impl Builder<'_> {
    fn reserve(&mut self, bytes: u64) -> Result<(), CaptureError> {
        if self.entries.len() >= self.limits.entries {
            return Err(CaptureError::LimitExceeded);
        }
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .filter(|&n| n <= self.limits.total_bytes)
            .ok_or(CaptureError::LimitExceeded)?;
        Ok(())
    }
    fn path(
        &mut self,
        path: &Path,
        kind: RiftObjectKind,
        parent: &[String],
    ) -> Result<(), CaptureError> {
        if !(self.allow)() {
            return Err(CaptureError::Cancelled);
        }
        if parent.len() >= self.limits.depth {
            return Err(CaptureError::LimitExceeded);
        }
        if !path.is_absolute()
            || path.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err(CaptureError::UnsupportedRepresentation);
        }
        let title = path
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| valid_name(n))
            .ok_or(CaptureError::UnsupportedRepresentation)?
            .to_owned();
        let mut capture_path = parent.to_vec();
        capture_path.push(title.clone());
        let meta = checked_metadata(path)?;
        if meta.is_dir() {
            self.reserve(0)?;
            self.entries.push(FrozenEntry {
                manifest: ObjectManifest {
                    kind: RiftObjectKind::Directory,
                    title,
                    capture_path: capture_path.clone(),
                    media_type: None,
                    preview: Preview::Folder,
                    size: 0,
                    sha256: None,
                },
                source: FrozenSource::Directory,
            });
            let mut children = Vec::new();
            for child in fs::read_dir(path).map_err(|_| CaptureError::SourceUnavailable)? {
                if children.len() >= self.limits.entries.saturating_sub(self.entries.len()) {
                    return Err(CaptureError::LimitExceeded);
                }
                children.push(child.map_err(|_| CaptureError::SourceUnavailable)?.path());
            }
            children.sort();
            for child in children {
                self.path(&child, RiftObjectKind::File, &capture_path)?;
            }
        } else if meta.is_file() {
            if matches!(kind, RiftObjectKind::Directory | RiftObjectKind::Collection) {
                return Err(CaptureError::UnsupportedRepresentation);
            }
            let stamp = Stamp::from(&meta)?;
            self.reserve(stamp.size)?;
            let mut file = open_file(path, stamp)?;
            let identity = file_identity(&file)?;
            let mut hash = Sha256::new();
            let mut remaining = stamp.size;
            while remaining != 0 {
                if !(self.allow)() {
                    return Err(CaptureError::Cancelled);
                }
                let limit = remaining.min(self.block.len() as u64) as usize;
                let n = file
                    .read(&mut self.block[..limit])
                    .map_err(|_| CaptureError::SourceUnavailable)?;
                if n == 0 {
                    return Err(CaptureError::SourceChanged);
                }
                remaining -= n as u64;
                hash.update(&self.block[..n]);
            }
            if file
                .read(&mut [0])
                .map_err(|_| CaptureError::SourceUnavailable)?
                != 0
                || Stamp::from(
                    &file
                        .metadata()
                        .map_err(|_| CaptureError::SourceUnavailable)?,
                )? != stamp
            {
                return Err(CaptureError::SourceChanged);
            }
            let digest: [u8; 32] = hash.finalize().into();
            self.entries.push(FrozenEntry {
                manifest: ObjectManifest {
                    kind,
                    title,
                    capture_path,
                    media_type: None,
                    preview: preview(kind),
                    size: stamp.size,
                    sha256: Some(hex(&digest)),
                },
                source: FrozenSource::File {
                    path: path.to_owned(),
                    digest,
                    stamp,
                    identity,
                },
            });
        } else {
            return Err(CaptureError::UnsupportedRepresentation);
        }
        Ok(())
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
}
fn preview(kind: RiftObjectKind) -> Preview {
    match kind {
        RiftObjectKind::Directory | RiftObjectKind::Collection => Preview::Folder,
        RiftObjectKind::WebPage | RiftObjectKind::Url | RiftObjectKind::MediaReference => {
            Preview::Link
        }
        RiftObjectKind::Image | RiftObjectKind::Video => Preview::Media,
        RiftObjectKind::PlainText
        | RiftObjectKind::RichText
        | RiftObjectKind::CodeSnippet
        | RiftObjectKind::Note => Preview::Text,
        _ => Preview::Filename,
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unsupported(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Reparse, Offline, RecallOnOpen, RecallOnDataAccess.
        if meta.file_attributes() & (0x400 | 0x1000 | 0x40000 | 0x400000) != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}
fn checked_metadata(path: &Path) -> Result<Metadata, CaptureError> {
    let meta = fs::symlink_metadata(path).map_err(|_| CaptureError::SourceUnavailable)?;
    if unsupported(&meta) {
        return Err(CaptureError::UnsupportedRepresentation);
    }
    for parent in path.ancestors().skip(1) {
        if unsupported(&fs::symlink_metadata(parent).map_err(|_| CaptureError::SourceUnavailable)?)
        {
            return Err(CaptureError::UnsupportedRepresentation);
        }
    }
    Ok(meta)
}
fn open_file(path: &Path, stamp: Stamp) -> Result<File, CaptureError> {
    if Stamp::from(&checked_metadata(path)?)? != stamp {
        return Err(CaptureError::SourceChanged);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT: do not follow.
    }
    let file = options
        .open(path)
        .map_err(|_| CaptureError::SourceUnavailable)?;
    let meta = file
        .metadata()
        .map_err(|_| CaptureError::SourceUnavailable)?;
    if !meta.is_file() || unsupported(&meta) || Stamp::from(&meta)? != stamp {
        return Err(CaptureError::SourceChanged);
    }
    Ok(file)
}

#[cfg(windows)]
type FileIdentity = (u32, u32, u32);
#[cfg(not(windows))]
type FileIdentity = ();

#[cfg(windows)]
fn file_identity(file: &File) -> Result<FileIdentity, CaptureError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(CaptureError::SourceUnavailable);
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}
#[cfg(not(windows))]
fn file_identity(_file: &File) -> Result<FileIdentity, CaptureError> {
    Ok(())
}

impl FrozenEntry {
    pub fn manifest(&self) -> &ObjectManifest {
        &self.manifest
    }

    /// The consumer must read to EOF before publishing or report a failed transfer.
    pub fn open_verified(&self) -> Result<Box<dyn Read + Send + '_>, CaptureError> {
        match &self.source {
            FrozenSource::File {
                path,
                digest,
                stamp,
                identity,
            } => {
                let file = open_file(path, *stamp)?;
                if file_identity(&file)? != *identity {
                    return Err(CaptureError::SourceChanged);
                }
                Ok(Box::new(Verified {
                    file,
                    remaining: stamp.size,
                    hash: Sha256::new(),
                    expected: *digest,
                    done: false,
                }))
            }
            FrozenSource::Inline(bytes) => Ok(Box::new(Cursor::new(bytes.as_slice()))),
            FrozenSource::Directory => Err(CaptureError::UnsupportedRepresentation),
        }
    }
}
struct Verified {
    file: File,
    remaining: u64,
    hash: Sha256,
    expected: [u8; 32],
    done: bool,
}
impl Read for Verified {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.done || out.is_empty() {
            return Ok(0);
        }
        let changed = || io::Error::new(io::ErrorKind::InvalidData, "captured source changed");
        if self.remaining == 0 {
            if self.file.read(&mut [0])? != 0
                || <[u8; 32]>::from(self.hash.clone().finalize()) != self.expected
            {
                return Err(changed());
            }
            self.done = true;
            return Ok(0);
        }
        let limit = (out.len() as u64).min(self.remaining) as usize;
        let n = self.file.read(&mut out[..limit])?;
        if n == 0 {
            return Err(changed());
        }
        self.hash.update(&out[..n]);
        self.remaining -= n as u64;
        // If an HTTP stream polls exactly the advertised length but never EOF, it still
        // must not observe a successful final read after a byte changed.
        if self.remaining == 0 {
            if self.file.read(&mut [0])? != 0
                || <[u8; 32]>::from(self.hash.clone().finalize()) != self.expected
            {
                return Err(changed());
            }
            self.done = true;
        }
        Ok(n)
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionActivity {
    #[default]
    Unknown,
    Unlocked,
    Locked,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CameraMode {
    Suspended,
    Reduced,
    Normal,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct AmbientPolicy {
    pub enabled: bool,
    pub paused: bool,
    pub window_open: bool,
    pub excluded_app: bool,
    pub battery_saver: bool,
    pub session: SessionActivity,
}
impl AmbientPolicy {
    pub fn may_capture(&self) -> bool {
        self.camera_mode() != CameraMode::Suspended
    }
    pub fn camera_mode(&self) -> CameraMode {
        if !self.enabled
            || self.paused
            || self.excluded_app
            || self.session != SessionActivity::Unlocked
        {
            CameraMode::Suspended
        } else if self.battery_saver {
            CameraMode::Reduced
        } else {
            CameraMode::Normal
        }
    }
}

/// Internal dispatch surface for later runtimes. Adapters never infer destinations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AmbientEvent {
    PolicyChanged(CameraMode),
    PickupRequested,
    ObjectFrozen { id: uuid::Uuid },
    CaptureFailed(CaptureError),
    DropRequested,
    TransferSessionChanged { id: uuid::Uuid },
    CaptureCancelled,
}
