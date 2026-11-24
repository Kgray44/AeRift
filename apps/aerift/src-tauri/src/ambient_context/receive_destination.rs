use super::{active_receive_folder, interactive_session, path_policy, CaptureAnchor, ContextError};
use aerift_transfer::{ambient_inbox::Inbox, ErrorCode, TransferError, TransferKey};
use std::{
    fs::{File, OpenOptions},
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDriveTypeW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ,
};

struct PinnedDirectory {
    path: PathBuf,
    identity: (u32, u64),
    _pins: Vec<File>,
}

impl PinnedDirectory {
    fn open(path: PathBuf) -> Result<Self, ContextError> {
        let text = path.to_str().ok_or(ContextError::UnsafeSelection)?;
        if !path_policy::is_drive_path(text, true) {
            return Err(ContextError::UnsafeSelection);
        }
        let volume = text[..3].encode_utf16().chain([0]).collect::<Vec<_>>();
        if unsafe { GetDriveTypeW(volume.as_ptr()) } != 3 {
            return Err(ContextError::UnsafeSelection);
        }
        let ancestors = path
            .ancestors()
            .take_while(|p| !p.as_os_str().is_empty())
            .collect::<Vec<_>>();
        if ancestors.is_empty() || ancestors.len() > 48 {
            return Err(ContextError::UnsafeSelection);
        }
        let mut pins = Vec::with_capacity(ancestors.len());
        for ancestor in ancestors.into_iter().rev() {
            // Pin root-to-leaf without share-write or share-delete. Refuse a
            // redirected, offline or non-directory component before traversing.
            let handle = OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(ancestor)
                .map_err(|_| ContextError::UnsafeSelection)?;
            let meta = handle
                .metadata()
                .map_err(|_| ContextError::UnsafeSelection)?;
            if !meta.is_dir() || !path_policy::safe_attributes(meta.file_attributes()) {
                return Err(ContextError::UnsafeSelection);
            }
            pins.push(handle);
        }
        let identity = directory_identity(pins.last().ok_or(ContextError::UnsafeSelection)?)?;
        Ok(Self {
            path,
            identity,
            _pins: pins,
        })
    }
}

fn directory_identity(file: &File) -> Result<(u32, u64), ContextError> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(ContextError::UnsafeSelection);
    }
    let file_id = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    if file_id == 0 {
        return Err(ContextError::UnsafeSelection);
    }
    Ok((info.dwVolumeSerialNumber, file_id))
}

/// One native-only proposal, bound to a verified Inbox receipt and a fixed
/// Explorer folder. It is not serializable, Clone, or a receive default.
pub(crate) struct PendingExplorerDelivery {
    key: TransferKey,
    target: PinnedDirectory,
    expires: Instant,
}

impl PendingExplorerDelivery {
    #[cfg(test)]
    pub(crate) fn synthetic_target_for_test(
        key: TransferKey,
        path: PathBuf,
    ) -> Result<Self, ContextError> {
        Ok(Self {
            key,
            target: PinnedDirectory::open(path)?,
            expires: Instant::now() + Duration::from_secs(30),
        })
    }

    /// Only use an anchor taken during the user's explicit Explorer action;
    /// never infer the path from an earlier app or ordinary Inbox acceptance.
    pub(crate) fn capture(anchor: CaptureAnchor, key: TransferKey) -> Result<Self, ContextError> {
        let target = PinnedDirectory::open(active_receive_folder(anchor)?)?;
        if active_receive_folder(anchor)? != target.path {
            return Err(ContextError::SelectionChanged);
        }
        Ok(Self {
            key,
            target,
            expires: Instant::now() + Duration::from_secs(30),
        })
    }

    pub(crate) fn display_target(&self) -> &Path {
        &self.target.path
    }

    /// Explicit native confirmation must name this exact target and receipt.
    /// A failure leaves the Inbox original intact. Never opens the result.
    pub(crate) fn authorize_save(
        self,
        inbox: &Inbox,
        confirmed_key: TransferKey,
        explicitly_approved: bool,
        protected_app_profile: &Path,
        still_authorized: impl Fn() -> bool,
    ) -> Result<(), TransferError> {
        if !explicitly_approved
            || confirmed_key != self.key
            || Instant::now() >= self.expires
            || !interactive_session()
            || !still_authorized()
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let private = protected_app_profile
            .canonicalize()
            .map_err(|_| ErrorCode::StorageFailed)?;
        let target = self
            .target
            .path
            .canonicalize()
            .map_err(|_| ErrorCode::StorageFailed)?;
        if target.starts_with(private) {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let receipt = inbox.verified_receipt(self.key)?;
        inbox.save_verified_copy_guarded(
            self.key,
            &self.target.path.join(&receipt.offer().name),
            || {
                still_authorized()
                    && interactive_session()
                    && PinnedDirectory::open(self.target.path.clone())
                        .is_ok_and(|current| current.identity == self.target.identity)
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_is_pinned_against_rename() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("destination");
        std::fs::create_dir(&path).unwrap();
        let pin = PinnedDirectory::open(path.clone()).unwrap();
        std::fs::write(path.join("synthetic.txt"), b"fixture").unwrap();
        assert!(std::fs::rename(&path, root.path().join("replacement")).is_err());
        drop(pin);
        std::fs::rename(&path, root.path().join("replacement")).unwrap();
    }
    #[test]
    fn rejects_network_and_noncanonical_targets() {
        for target in [
            r"\\server\share\target",
            r"C:relative",
            r"C:\folder\..",
            r"C:\dir:x",
        ] {
            assert!(PinnedDirectory::open(PathBuf::from(target)).is_err());
        }
    }
}
