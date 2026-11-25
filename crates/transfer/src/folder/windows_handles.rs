//! Experimental Win32 directory publication, exercised only in native tests.
//! All untrusted filesystem names are single validated relative leaves.
use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    mem::{offset_of, size_of},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, Prefix},
    ptr::{self, null, null_mut},
};

use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
            FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION, FILE_SYNCHRONOUS_IO_NONALERT,
            FILE_WRITE_THROUGH, FileRenameInformation, NtCreateFile, NtSetInformationFile,
        },
    },
    Win32::{
        Foundation::{
            GENERIC_WRITE, HANDLE, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, RtlNtStatusToDosError,
            UNICODE_STRING,
        },
        Storage::FileSystem::{
            DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FileAttributeTagInfo,
            FileDispositionInfo, GetDriveTypeW, GetFileInformationByHandleEx,
            GetFinalPathNameByHandleW, GetVolumeInformationByHandleW, QueryDosDeviceW, SYNCHRONIZE,
            SetFileInformationByHandle, VOLUME_NAME_GUID, VOLUME_NAME_NT,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

use crate::model::safe_name;

// Prototype discovery only. Not a production capability or IPC surface.
#[cfg(test)]
#[path = "windows_directory_page.rs"]
mod directory_page;

const DIRECTORY_ACCESS: u32 = FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES;

pub struct PinnedDirectory(File, Vec<File>);

impl PinnedDirectory {
    /// The future native host must supply an independently trusted volume
    /// or picker capability. This does not authorize an arbitrary raw path.
    fn from_handle(file: File) -> io::Result<Self> {
        inspect_plain_directory(&file)?;
        restrict_ntfs(&file)?;
        Ok(Self(file, Vec::new()))
    }

    /// Consume a path returned by the trusted native folder picker, not a
    /// webview string. Pin the drive and every plain NTFS component with no
    /// DELETE sharing. The returned object can no longer be redirected by
    /// replacing names, and is the only destination authority used for export.
    pub fn from_native_selection(path: &Path) -> io::Result<Self> {
        let mut components = path.components();
        let drive = match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(letter) => letter,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "unqualified destination drive",
                    ));
                }
            },
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "unqualified destination drive",
                ));
            }
        };
        if components.next() != Some(Component::RootDir) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "relative destination",
            ));
        }
        let volume = [drive.to_ascii_uppercase() as u16, b':' as u16, 0_u16];
        let root = [volume[0], volume[1], b'\\' as u16, 0_u16];
        // Both strings are NUL-terminated. Reject SUBST/UNC/not-fixed roots
        // before obtaining the single absolute filesystem capability.
        let mut name = [0_u16; 512];
        let len = unsafe { QueryDosDeviceW(volume.as_ptr(), name.as_mut_ptr(), name.len() as u32) };
        let first = name
            .iter()
            .position(|item| *item == 0)
            .unwrap_or(name.len());
        let target = String::from_utf16(&name[..first]).unwrap_or_default();
        let harddisk_volume =
            target
                .strip_prefix(r"\Device\HarddiskVolume")
                .is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
                });
        // 3 is DRIVE_FIXED. QueryDosDevice can also return drives mapped via
        // SUBST, so checking only GetDriveTypeW is not sufficient.
        if len == 0 || !harddisk_volume || unsafe { GetDriveTypeW(root.as_ptr()) } != 3 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "destination is not a fixed NTFS volume",
            ));
        }
        let drive_root = format!("{}:\\", drive as char);
        let mut directory = Self::from_handle(
            OpenOptions::new()
                .access_mode(DIRECTORY_ACCESS)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(drive_root)?,
        )?;
        let mut actual = [0_u16; 512];
        let actual_len = unsafe {
            GetFinalPathNameByHandleW(
                directory.0.as_raw_handle().cast(),
                actual.as_mut_ptr(),
                actual.len() as u32,
                VOLUME_NAME_NT,
            )
        } as usize;
        if actual_len == 0
            || actual_len >= actual.len()
            || !String::from_utf16_lossy(&actual[..actual_len])
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(&target)
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "selected drive changed",
            ));
        }
        let mut ancestors = Vec::new();
        for part in components {
            let Component::Normal(leaf) = part else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid destination component",
                ));
            };
            let leaf = leaf.to_str().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "unsupported destination encoding",
                )
            })?;
            let child = directory.open_child(leaf, false)?;
            ancestors.push(directory.0);
            directory = child;
        }
        // Volume roots are not suitable default destinations.
        if ancestors.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "select an existing folder below the volume root",
            ));
        }
        directory.1 = ancestors;
        Ok(directory)
    }

    fn open_child(&self, leaf: &str, source_for_rename: bool) -> io::Result<Self> {
        inspect_plain_directory(&self.0)?;
        let access = DIRECTORY_ACCESS | if source_for_rename { DELETE } else { 0 };
        Self::from_handle(relative_open(
            &self.0,
            leaf,
            access,
            FILE_OPEN,
            FILE_DIRECTORY_FILE,
        )?)
    }

    fn make_child(&self, leaf: &str) -> io::Result<Self> {
        inspect_plain_directory(&self.0)?;
        Self::from_handle(relative_open(
            &self.0,
            leaf,
            DIRECTORY_ACCESS | DELETE,
            FILE_CREATE,
            FILE_DIRECTORY_FILE,
        )?)
    }

    // Windows FlushFileBuffers (Rust File::sync_all) requires GENERIC_WRITE.
    // These write rights are limited to files we create exclusively; no
    // directory or existing destination handle receives additional access.
    fn make_file(&self, leaf: &str) -> io::Result<File> {
        inspect_plain_directory(&self.0)?;
        relative_open(
            &self.0,
            leaf,
            GENERIC_WRITE | DELETE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_WRITE_THROUGH,
        )
    }

    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self(
            self.0.try_clone()?,
            self.1
                .iter()
                .map(File::try_clone)
                .collect::<io::Result<Vec<_>>>()?,
        ))
    }

    /// Compare the operating system's volume identities for held handles.
    /// No drive letter, pathname, or caller-supplied identifier is authoritative.
    pub fn shares_atomic_publish_volume(&self, destination: &Self) -> io::Result<bool> {
        Ok(held_volume_guid(&self.0)? == held_volume_guid(&destination.0)?)
    }

    pub fn open_verified_envelope(&self, leaf: &str) -> io::Result<File> {
        use windows_sys::Win32::Storage::FileSystem::FILE_READ_DATA;
        inspect_plain_directory(&self.0)?;
        let file = relative_open(
            &self.0,
            leaf,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )?;
        inspect_plain(&file, false)?;
        Ok(file)
    }

    /// Backed by a trusted profile directory. File creation is exclusive even
    /// when two processes race or a reparse point occupies the receipt name.
    fn reserve(&self, unique_receipt_leaf: &str) -> io::Result<()> {
        inspect_plain_directory(&self.0)?;
        let mut file = relative_open(
            &self.0,
            unique_receipt_leaf,
            GENERIC_WRITE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_WRITE_THROUGH,
        )?;
        file.write_all(b"spent\r\n")?;
        file.sync_all()
    }
}

fn checked_leaf(leaf: &str) -> io::Result<Vec<u16>> {
    if !leaf.is_ascii() || !safe_name(leaf) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid folder leaf",
        ));
    }
    Ok(leaf.encode_utf16().collect())
}

fn relative_open(
    parent: &File,
    leaf: &str,
    access: u32,
    disposition: u32,
    options: u32,
) -> io::Result<File> {
    let mut wide = checked_leaf(leaf)?;
    let byte_count = (wide.len() * size_of::<u16>()) as u16;
    let name = UNICODE_STRING {
        Length: byte_count,
        MaximumLength: byte_count,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle() as HANDLE,
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut status_block: IO_STATUS_BLOCK = IO_STATUS_BLOCK::default();
    let mut handle: HANDLE = null_mut();
    // All descriptors and UTF-16 storage outlive the synchronous NtCreateFile.
    // The leaf excludes any separators, stream syntax, aliases, or traversal.
    // Refusing DELETE sharing keeps held ancestor handles pinned against rename.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE,
            &attributes,
            &mut status_block,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            disposition,
            options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    };
    if status < 0 {
        // Converts a returned NTSTATUS, not an untrusted raw value.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    if handle.is_null() {
        return Err(io::Error::other("NtCreateFile returned no handle"));
    }
    // A successful open transfers ownership of this new handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}

fn inspect_plain_directory(file: &File) -> io::Result<()> {
    inspect_plain(file, true)
}

fn inspect_plain(file: &File, directory: bool) -> io::Result<()> {
    let mut tag: FILE_ATTRIBUTE_TAG_INFO = FILE_ATTRIBUTE_TAG_INFO::default();
    // Valid owned file handle and writable, correctly sized attribute buffer.
    let result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileAttributeTagInfo,
            ptr::from_mut(&mut tag).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "not a plain directory",
        ));
    }
    Ok(())
}

fn held_volume_guid(file: &File) -> io::Result<[u8; 36]> {
    inspect_plain_directory(file)?;
    let mut output = vec![0_u16; 512];
    // The owning File keeps the native handle alive for both calls.
    let query = |output: &mut [u16]| unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle() as HANDLE,
            output.as_mut_ptr(),
            output.len() as u32,
            VOLUME_NAME_GUID,
        )
    } as usize;
    let mut length = query(&mut output);
    if length >= output.len() && length <= 32_768 {
        output.resize(length + 1, 0);
        length = query(&mut output);
    }
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length >= output.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported final volume name",
        ));
    }
    parse_native_volume_guid(&output[..length]).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "unrecognized native volume identity",
        )
    })
}

// Only parse the namespace prefix returned by the kernel. The remaining path
// may include arbitrary Unicode; it does not contribute to the comparison.
fn parse_native_volume_guid(path: &[u16]) -> Option<[u8; 36]> {
    const PREFIX: &[u8] = b"\\\\?\\Volume{";
    if path.len() < PREFIX.len() + 38
        || !path.iter().zip(PREFIX).all(|(&unit, &expected)| {
            u8::try_from(unit).is_ok_and(|byte| byte.eq_ignore_ascii_case(&expected))
        })
    {
        return None;
    }
    let mut guid = [0_u8; 36];
    for (index, byte) in guid.iter_mut().enumerate() {
        *byte = u8::try_from(path[PREFIX.len() + index])
            .ok()?
            .to_ascii_lowercase();
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return None;
            }
        } else if !byte.is_ascii_hexdigit() {
            return None;
        }
    }
    if path[PREFIX.len() + 36] != b'}' as u16 || path[PREFIX.len() + 37] != b'\\' as u16 {
        return None;
    }
    Some(guid)
}

fn restrict_ntfs(file: &File) -> io::Result<()> {
    let mut filesystem_name = [0_u16; 32];
    // Query the filesystem of the held object, not its current pathname.
    let result = unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle() as HANDLE,
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            null_mut(),
            filesystem_name.as_mut_ptr(),
            filesystem_name.len() as u32,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    if filesystem_name[..5] != [b'N' as u16, b'T' as u16, b'F' as u16, b'S' as u16, 0] {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "native export requires NTFS",
        ));
    }
    Ok(())
}

fn rename_no_replace(
    source: &PinnedDirectory,
    target: &PinnedDirectory,
    leaf: &str,
) -> io::Result<()> {
    let wide = checked_leaf(leaf)?;
    inspect_plain_directory(&source.0)?;
    inspect_plain_directory(&target.0)?;
    let file_name_offset = offset_of!(FILE_RENAME_INFORMATION, FileName);
    let name_bytes = wide.len() * size_of::<u16>();
    let bytes = (file_name_offset + name_bytes).max(size_of::<FILE_RENAME_INFORMATION>());
    // usize alignment covers the frame's largest field (HANDLE). The
    // native length is a byte count; no pathname or terminator is needed.
    let mut frame = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
    let header = frame.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    let mut status_block = IO_STATUS_BLOCK::default();
    // The source is a synchronous DELETE-capable handle. The selected
    // destination is its independently pinned root; FileName is exactly
    // one validated leaf. Zero ReplaceIfExists: no replacement or fallback.
    let status = unsafe {
        (*header).RootDirectory = target.0.as_raw_handle() as HANDLE;
        (*header).FileNameLength = name_bytes as u32;
        ptr::copy_nonoverlapping(
            wide.as_ptr(),
            frame
                .as_mut_ptr()
                .cast::<u8>()
                .add(file_name_offset)
                .cast::<u16>(),
            wide.len(),
        );
        NtSetInformationFile(
            source.0.as_raw_handle() as HANDLE,
            &mut status_block,
            header.cast(),
            bytes as u32,
            FileRenameInformation,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ))
    }
}

fn delete_when_closed(file: &File) -> io::Result<()> {
    let setting = FILE_DISPOSITION_INFO { DeleteFile: true };
    // The live handle was opened with DELETE rights, with a correctly-sized
    // disposition record. No names or path resolution occur here.
    let result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as HANDLE,
            FileDispositionInfo,
            ptr::from_ref(&setting).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

use std::{
    collections::HashMap,
    io::{Seek, SeekFrom},
};

#[cfg(test)]
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    BUFFER, admission::AdmittedFolder, finish_envelope, guard, read_envelope_manifest, storage,
    validate_completed_receipt, verify_copy,
};
#[cfg(test)]
use crate::Receiver;
use crate::{ErrorCode, IncomingTransfer, TransferError, TransferKey, ambient::RiftObjectKind};

/// Handles are created by the trusted native picker/profile adapter. No
/// absolute path, relative path, display text or A7 delivery token is accepted.
pub struct WindowsFolderExport {
    pub private_scratch: PinnedDirectory,
    pub private_ledger: PinnedDirectory,
    pub selected_destination: PinnedDirectory,
    pub verified_envelope: File,
}

#[cfg(test)]
impl Receiver {
    fn commit_resumable_folder(
        &self,
        typed: &AdmittedFolder,
        destination: WindowsFolderExport,
        cancel: &CancellationToken,
    ) -> Result<String, TransferError> {
        let (receipt, trust) = self.completed_resumable(typed.key())?;
        commit_verified_folder(&receipt, typed, destination, || {
            !cancel.is_cancelled() && !trust.is_cancelled()
        })
    }
}

pub fn commit_verified_folder(
    receipt: &IncomingTransfer,
    typed: &AdmittedFolder,
    destination: WindowsFolderExport,
    allowed: impl Fn() -> bool,
) -> Result<String, TransferError> {
    guard(&allowed)?;
    validate_completed_receipt(receipt)?;
    if typed.key() != receipt.key || typed.envelope() != &receipt.offer {
        return Err(ErrorCode::PeerUntrusted.into());
    }
    let WindowsFolderExport {
        private_scratch,
        private_ledger,
        selected_destination,
        mut verified_envelope,
    } = destination;
    if !private_scratch
        .shares_atomic_publish_volume(&selected_destination)
        .map_err(storage)?
    {
        return Err(ErrorCode::StorageFailed.into());
    }
    inspect_plain(&verified_envelope, false).map_err(storage)?;
    restrict_ntfs(&verified_envelope).map_err(storage)?;
    if verified_envelope.metadata().map_err(storage)?.len() != receipt.offer.size_bytes {
        return Err(ErrorCode::IntegrityFailed.into());
    }
    verified_envelope
        .seek(SeekFrom::Start(0))
        .map_err(storage)?;
    let (mut reader, entries, control_frame) = read_envelope_manifest(verified_envelope, receipt)?;
    let leaf = entries[0].title.clone();
    typed.verify_object_metadata(&control_frame, &leaf, entries.len())?;

    let scratch_name = format!("aerift-stage-{}", Uuid::new_v4());
    let mut stage = StagedHandles {
        wrapper: private_scratch.make_child(&scratch_name).map_err(storage)?,
        created: Vec::new(),
        moved: false,
    };
    let mut directories = HashMap::new();
    let mut block = vec![0; BUFFER];
    for entry in entries {
        guard(&allowed)?;
        let last = entry.capture_path.len() - 1;
        let parent = if last == 0 {
            &stage.wrapper
        } else {
            directories
                .get(&entry.capture_path[..last])
                .ok_or(ErrorCode::IntegrityFailed)?
        };
        if entry.kind == RiftObjectKind::Directory {
            let directory = parent.make_child(&entry.title).map_err(storage)?;
            stage.created.push((entry.capture_path.clone(), true));
            directories.insert(entry.capture_path, directory);
        } else {
            let mut output = parent.make_file(&entry.title).map_err(storage)?;
            stage.created.push((entry.capture_path.clone(), false));
            verify_copy(&mut reader, &mut output, &entry, &mut block, &allowed)?;
            output
                .sync_all()
                .map_err(|error| export_io("flush staged file", error))?;
        }
    }
    finish_envelope(reader, receipt)?;
    // NTFS can refuse a directory rename when any descendant is held open.
    // The entire prepared tree remains under the trusted private stage.
    drop(directories);
    let source = stage.wrapper.open_child(&leaf, true).map_err(storage)?;
    guard(&allowed)?;
    let marker = receipt_name(receipt.key);
    private_ledger
        .reserve(&marker)
        .map_err(|error| export_conflict_io("reserve and flush receipt", error))?;
    guard(&allowed)?;
    rename_no_replace(&source, &selected_destination, &leaf)
        .map_err(|error| export_conflict_io("atomic directory publish", error))?;
    stage.moved = true;
    Ok(leaf)
}

fn receipt_name(key: TransferKey) -> String {
    format!("folder-v1-{}-{}", key.peer, key.id)
}

fn export_io(operation: &str, error: io::Error) -> TransferError {
    #[cfg(test)]
    eprintln!(
        "Windows folder qualification: {operation}, raw error {:?}",
        error.raw_os_error()
    );
    #[cfg(not(test))]
    let _ = operation;
    storage(error)
}

fn export_conflict_io(operation: &str, error: io::Error) -> TransferError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        ErrorCode::Conflict.into()
    } else {
        export_io(operation, error)
    }
}

struct StagedHandles {
    wrapper: PinnedDirectory,
    created: Vec<(Vec<String>, bool)>,
    moved: bool,
}

impl Drop for StagedHandles {
    fn drop(&mut self) {
        if !self.moved {
            // Re-open only tracked single leaves through held handles, in
            // reverse topological order. Never follow a reparse or clean by path.
            for (path, is_directory) in self.created.iter().rev() {
                let Some((leaf, parents)) = path.split_last() else {
                    continue;
                };
                let mut node = &self.wrapper;
                let mut parents_held = Vec::new();
                for part in parents {
                    let Ok(child) = node.open_child(part, false) else {
                        break;
                    };
                    parents_held.push(child);
                    node = parents_held.last().unwrap();
                }
                if parents_held.len() != parents.len() {
                    continue;
                }
                if *is_directory {
                    if let Ok(child) = node.open_child(leaf, true) {
                        let _ = delete_when_closed(&child.0);
                    }
                } else if let Ok(file) =
                    relative_open(&node.0, leaf, DELETE, FILE_OPEN, FILE_NON_DIRECTORY_FILE)
                {
                    let _ = delete_when_closed(&file);
                }
            }
        }
        // Failure to clean leaves only profile-private data and cannot be
        // retried as an export. A later native housekeeping pass may retry.
        let _ = delete_when_closed(&self.wrapper.0);
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::windows::{fs::OpenOptionsExt, process::CommandExt},
        path::Path,
        process::Command,
    };

    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    use super::*;

    fn synthetic_root(path: &Path) -> PinnedDirectory {
        PinnedDirectory::from_handle(
            fs::OpenOptions::new()
                .access_mode(DIRECTORY_ACCESS)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn ntfs_typed_completed_receipt_is_verified_staged_and_published_once() {
        use crate::{
            PeerId, ReceiveLimits, State,
            ambient::{Candidate, CaptureContext, CaptureLimits, freeze},
            folder::{
                MAX_BYTES,
                admission::{FolderCapability, FolderRepresentation},
                prepare_folder,
            },
        };
        use std::sync::Arc;
        let temp = tempfile::Builder::new()
            .prefix("aerift-ntfs-")
            .tempdir()
            .unwrap();
        let root = temp.path();
        for leaf in [
            "input/Tree/Empty",
            "scratch",
            "ledger",
            "target",
            "alternate",
            "received",
        ] {
            fs::create_dir_all(root.join(leaf)).unwrap();
        }
        fs::write(root.join("input/Tree/content"), b"typed test bytes").unwrap();
        let capture = freeze(
            CaptureContext {
                explicit_selection: vec![Candidate::path(root.join("input/Tree"))],
                ..Default::default()
            },
            CaptureLimits::default(),
        )
        .unwrap();
        let prepared = prepare_folder(Arc::new(capture), &CancellationToken::new()).unwrap();
        let advertised = FolderCapability {
            representation: FolderRepresentation::FolderManifestV1,
            maximum_envelope_bytes: MAX_BYTES,
        };
        let sender = PeerId::from_tls_leaf(b"synthetic sender");
        let local = PeerId::from_tls_leaf(b"synthetic receiver");
        let id = Uuid::new_v4();
        let binding = [0x62; 32];
        let typed_bytes = prepared
            .encode_typed_offer(&advertised, id, sender, local, binding)
            .unwrap();
        let typed = AdmittedFolder::from_remote_control(
            &typed_bytes,
            Some(&advertised),
            sender,
            local,
            binding,
        )
        .unwrap();
        let key = typed.key();
        let bytes = prepared
            .block(0, typed.envelope().size_bytes as usize)
            .unwrap();
        let receiver = Arc::new(
            Receiver::new_resumable(
                &root.join("received"),
                ReceiveLimits {
                    active_bytes: 1024 * 1024,
                    session_offers: 4,
                },
            )
            .unwrap(),
        );
        let trust = CancellationToken::new();
        receiver
            .offer_resumable(sender, typed.envelope().clone(), &trust)
            .unwrap();
        let base = synthetic_root(root);
        let host = |target: &str, raw: &Path| WindowsFolderExport {
            private_scratch: base.open_child("scratch", false).unwrap(),
            private_ledger: base.open_child("ledger", false).unwrap(),
            selected_destination: PinnedDirectory::from_native_selection(&root.join(target))
                .unwrap(),
            verified_envelope: File::open(raw).unwrap(),
        };
        fs::write(root.join("uncorrelated"), b"not a receipt").unwrap();
        assert!(
            receiver
                .commit_resumable_folder(
                    &typed,
                    host("target", &root.join("uncorrelated")),
                    &CancellationToken::new(),
                )
                .is_err()
        );
        receiver.respond(key, true).unwrap();
        receiver.append_resumable(key, 0, &bytes).unwrap();
        assert_eq!(
            receiver.commit_resumable(key).unwrap().state,
            State::Completed
        );
        let (receipt, _) = receiver.completed_resumable(key).unwrap();
        let saved = receipt.saved_path.unwrap();

        let mut tampered = bytes;
        *tampered.last_mut().unwrap() ^= 0x80;
        fs::write(root.join("tampered"), tampered).unwrap();
        assert!(
            receiver
                .commit_resumable_folder(
                    &typed,
                    host("target", &root.join("tampered")),
                    &CancellationToken::new(),
                )
                .is_err()
        );
        assert_eq!(fs::read_dir(root.join("scratch")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(root.join("target")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(root.join("ledger")).unwrap().count(), 0);

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(
            receiver
                .commit_resumable_folder(&typed, host("target", &saved), &cancelled)
                .is_err()
        );
        assert_eq!(
            receiver
                .commit_resumable_folder(&typed, host("target", &saved), &CancellationToken::new(),)
                .unwrap(),
            "Tree"
        );
        assert!(root.join("target/Tree/Empty").is_dir());
        assert_eq!(
            fs::read(root.join("target/Tree/content")).unwrap(),
            b"typed test bytes"
        );
        assert!(
            receiver
                .commit_resumable_folder(
                    &typed,
                    host("alternate", &saved),
                    &CancellationToken::new(),
                )
                .is_err()
        );
        assert_eq!(fs::read_dir(root.join("alternate")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(root.join("scratch")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(root.join("ledger")).unwrap().count(), 1);
        trust.cancel();
        assert!(
            receiver
                .commit_resumable_folder(&typed, host("target", &saved), &CancellationToken::new(),)
                .is_err()
        );
    }

    #[test]
    fn ntfs_folder_child_checks_spent_receipt() {
        let Some(path) = std::env::var_os("AERIFT_SYNTHETIC_FOLDER_LEDGER") else {
            return;
        };
        let ledger = synthetic_root(Path::new(&path));
        assert_eq!(
            fs::read(Path::new(&path).join("synthetic-receipt-v1")).unwrap(),
            b"spent\r\n",
        );
        assert!(ledger.reserve("synthetic-receipt-v1").is_err());
        ledger.reserve("synthetic-new-process-control").unwrap();
    }

    #[test]
    fn native_guid_distinguishes_volumes_without_using_names_or_labels() {
        let native =
            |name: &str| parse_native_volume_guid(&name.encode_utf16().collect::<Vec<_>>());
        let first = native(r"\\?\Volume{a1111111-2222-3333-4444-555555555555}\path").unwrap();
        assert_eq!(
            first,
            native(r"\\?\volume{A1111111-2222-3333-4444-555555555555}\different").unwrap()
        );
        assert_ne!(
            first,
            native(r"\\?\Volume{a1111112-2222-3333-4444-555555555555}\path").unwrap()
        );
        assert!(native(r"C:\Volume{a1111111-2222-3333-4444-555555555555}\path").is_none());
        assert!(native(r"\\?\Volume{not-a-guid}\path").is_none());
    }

    #[test]
    fn ntfs_no_replace_is_atomic_against_a_competing_leaf_creator() {
        let temp = tempfile::Builder::new()
            .prefix("aerift-ntfs-")
            .tempdir()
            .unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("stage/Tree")).unwrap();
        fs::write(root.join("stage/Tree/payload"), b"fixture").unwrap();
        fs::create_dir(root.join("destination")).unwrap();
        let volume = synthetic_root(root);
        let stage = volume.open_child("stage", false).unwrap();
        let source = stage.open_child("Tree", true).unwrap();
        let target = volume.open_child("destination", false).unwrap();
        assert!(stage.shares_atomic_publish_volume(&target).unwrap());
        let claim = root.join("destination/Tree");
        let barrier = std::sync::Barrier::new(2);
        let (created, published) = std::thread::scope(|scope| {
            let contender = scope.spawn(|| {
                barrier.wait();
                fs::create_dir(&claim).is_ok()
            });
            barrier.wait();
            let published = rename_no_replace(&source, &target, "Tree").is_ok();
            (contender.join().unwrap(), published)
        });
        assert_ne!(
            created, published,
            "exactly one filesystem operation may win"
        );
        assert_eq!(claim.join("payload").is_file(), published);
        assert_eq!(root.join("stage/Tree/payload").is_file(), created);
    }

    #[test]
    fn ntfs_pinned_relative_publish_refuses_junction_collision_and_replay() {
        let temp = tempfile::Builder::new()
            .prefix("aerift-ntfs-")
            .tempdir()
            .unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("stage/Tree/Empty")).unwrap();
        fs::write(
            root.join("stage/Tree/synthetic.txt"),
            b"receipt-verifiable fixture",
        )
        .unwrap();
        for leaf in ["destination", "ledger", "outside"] {
            fs::create_dir(root.join(leaf)).unwrap();
        }
        let junction = root.join("destination/Jump");
        fs::write(root.join("outside/junction-proof"), b"actual junction").unwrap();
        // cmd.exe does not use CommandLineToArgvW quoting. Keep this
        // command a fixed literal and set cwd as a separate API parameter.
        let output = Command::new("cmd.exe")
            .args(["/D", "/C"])
            .raw_arg(r"mklink /J destination\Jump outside")
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Windows hosted runner must support a real junction: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        assert_eq!(
            fs::read(junction.join("junction-proof")).unwrap(),
            b"actual junction"
        );
        fs::remove_file(root.join("outside/junction-proof")).unwrap();
        let trusted = synthetic_root(root);
        assert!(trusted.open_child("stage/Tree", false).is_err());
        let stage = trusted.open_child("stage", false).unwrap();
        let source = stage.open_child("Tree", true).unwrap();
        let dest = trusted.open_child("destination", false).unwrap();
        assert!(dest.open_child("Jump", false).is_err());
        assert!(PinnedDirectory::from_native_selection(&junction).is_err());
        assert!(
            fs::rename(root.join("destination"), root.join("substituted")).is_err(),
            "the live destination handle must deny path substitution",
        );
        assert!(rename_no_replace(&source, &dest, "Jump").is_err());
        assert_eq!(fs::read_dir(root.join("outside")).unwrap().count(), 0);
        fs::create_dir(root.join("destination/Tree")).unwrap();
        assert!(rename_no_replace(&source, &dest, "Tree").is_err());
        assert!(root.join("stage/Tree/Empty").is_dir());
        fs::remove_dir(root.join("destination/Tree")).unwrap();
        let ledger = trusted.open_child("ledger", false).unwrap();
        ledger.reserve("synthetic-receipt-v1").unwrap();
        rename_no_replace(&source, &dest, "Tree").unwrap();
        assert!(!root.join("stage/Tree").exists());
        assert!(root.join("destination/Tree/Empty").is_dir());
        assert_eq!(
            fs::read(root.join("destination/Tree/synthetic.txt")).unwrap(),
            b"receipt-verifiable fixture"
        );
        drop(ledger);
        let binary = std::env::current_exe().unwrap();
        let output = Command::new(binary)
            .args([
                "--exact",
                "folder::windows_handles::tests::ntfs_folder_child_checks_spent_receipt",
                "--nocapture",
            ])
            .env("AERIFT_SYNTHETIC_FOLDER_LEDGER", root.join("ledger"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "new process did not verify the spent receipt: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        let reopened = trusted.open_child("ledger", false).unwrap();
        assert!(reopened.reserve("synthetic-receipt-v1").is_err());
        drop(reopened);
        drop(source);
        drop(dest);
        drop(stage);
        drop(trusted);
        // Remove the junction itself before TempDir recurses.
        fs::remove_dir(junction).unwrap();
    }
}
