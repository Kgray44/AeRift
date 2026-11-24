//! Linux-only explicit directory publication. No fallback to path-based rename.
use std::{
    fs::{self, File},
    io::Write,
    os::fd::AsRawFd,
    path::{Component, Path},
};

use rustix::{
    fs::{self as rfs, Mode, OFlags, RenameFlags, ResolveFlags},
    io::Errno,
    process::geteuid,
};
use tokio_util::sync::CancellationToken;

use super::{guard, stage_verified_folder, storage};
use crate::{ErrorCode, Receiver, TransferError, TransferKey, ambient::ReceiverCapabilities};

/// An explicit export operates only on this local profile's private scratch
/// and receipt ledger, and on one existing destination selected by the user.
/// Host paths must be absolute. This is not a native dialog or an IPC surface.
pub struct FolderExport<'a> {
    pub private_scratch: &'a Path,
    pub private_ledger: &'a Path,
    pub selected_destination: &'a Path,
}

impl Receiver {
    /// Atomically place the verified tree, preserving any existing object at
    /// the target name. The completed receipt is spent before rename; failures
    /// after reservation remain spent rather than permitting a replay.
    pub fn commit_resumable_folder(
        &self,
        key: TransferKey,
        capability: ReceiverCapabilities,
        destination: FolderExport<'_>,
        cancel: &CancellationToken,
    ) -> Result<String, TransferError> {
        if !capability.object_manifest_v1 {
            return Err(ErrorCode::UnsupportedVersion.into());
        }
        let (receipt, trust) = self.completed_resumable(key)?;
        let allowed = || !cancel.is_cancelled() && !trust.is_cancelled();
        guard(&allowed)?;
        let scratch = pin(destination.private_scratch, true)?;
        let ledger = pin(destination.private_ledger, true)?;
        let target = pin(destination.selected_destination, false)?;
        let stage_stat = rfs::fstat(&scratch).map_err(storage)?;
        let target_stat = rfs::fstat(&target).map_err(storage)?;
        let ledger_stat = rfs::fstat(&ledger).map_err(storage)?;
        if stage_stat.st_dev != target_stat.st_dev
            || (stage_stat.st_dev, stage_stat.st_ino) == (target_stat.st_dev, target_stat.st_ino)
            || (ledger_stat.st_dev, ledger_stat.st_ino) == (target_stat.st_dev, target_stat.st_ino)
        {
            return Err(ErrorCode::StorageFailed.into());
        }
        // Anchor even relative TempDir cleanup to the held scratch directory.
        // The profile's 0700 scratch is not writable by remote users or peers.
        let scratch_alias =
            std::path::PathBuf::from(format!("/proc/self/fd/{}", scratch.as_raw_fd()));
        let staged = stage_verified_folder(&receipt, &scratch_alias, allowed)?;
        let leaf = staged
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(ErrorCode::StorageFailed)?
            .to_owned();
        let stage_leaf = staged
            ._private_root
            .path()
            .file_name()
            .ok_or(ErrorCode::StorageFailed)?;
        let stage_fd: File = rfs::openat(&scratch, stage_leaf, directory_flags(), Mode::empty())
            .map_err(storage)?
            .into();
        sync_tree(staged.path(), &allowed)?;
        stage_fd.sync_all().map_err(storage)?;

        // Fast fail without burning a receipt on an already present target.
        // renameat2 below is the authoritative race-safe no-replace boundary.
        match rfs::statat(&target, leaf.as_str(), rfs::AtFlags::SYMLINK_NOFOLLOW) {
            Err(Errno::NOENT) => {}
            Err(error) => return Err(storage(error)),
            Ok(_) => return Err(ErrorCode::Conflict.into()),
        }

        guard(&allowed)?;
        reserve(&ledger, key)?;
        guard(&allowed)?;
        match rfs::renameat_with(
            &stage_fd,
            leaf.as_str(),
            &target,
            leaf.as_str(),
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {}
            Err(Errno::EXIST | Errno::NOTEMPTY) => return Err(ErrorCode::Conflict.into()),
            Err(error) => return Err(storage(error)),
        }
        // Publication is already visible. A sync failure is not a claim of
        // durable completion and never authorizes another use of this receipt.
        target.sync_all().map_err(storage)?;
        stage_fd.sync_all().map_err(storage)?;
        Ok(leaf)
    }
}

fn directory_flags() -> OFlags {
    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
}

fn pin(path: &Path, private: bool) -> Result<File, TransferError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let file = rfs::openat2(
        rfs::CWD,
        path,
        directory_flags(),
        Mode::empty(),
        ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(storage)?;
    let info = rfs::fstat(&file).map_err(storage)?;
    if private && (info.st_uid != geteuid().as_raw() || info.st_mode & 0o077 != 0) {
        return Err(ErrorCode::StorageFailed.into());
    }
    Ok(file.into())
}

fn sync_tree(path: &Path, allowed: &impl Fn() -> bool) -> Result<(), TransferError> {
    guard(allowed)?;
    for entry in fs::read_dir(path).map_err(storage)? {
        guard(allowed)?;
        let entry = entry.map_err(storage)?;
        let kind = entry.file_type().map_err(storage)?;
        if kind.is_dir() {
            sync_tree(&entry.path(), allowed)?;
        } else if !kind.is_file() {
            return Err(ErrorCode::StorageFailed.into());
        }
    }
    let directory: File = rfs::open(path, directory_flags(), Mode::empty())
        .map_err(storage)?
        .into();
    directory.sync_all().map_err(storage)?;
    Ok(())
}

fn reserve(ledger: &File, key: TransferKey) -> Result<(), TransferError> {
    // Scope by peer plus transfer ID, not target directory or manifest. Even
    // swapping the selected folder or offering altered content cannot replay it.
    let id = format!("folder-v1-{}-{}", key.peer, key.id);
    let entry = match rfs::openat(
        ledger,
        id.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    ) {
        Ok(file) => file,
        Err(Errno::EXIST) => return Err(ErrorCode::Conflict.into()),
        Err(error) => return Err(storage(error)),
    };
    let mut entry = File::from(entry);
    entry.write_all(b"spent\n").map_err(storage)?;
    entry.sync_all().map_err(storage)?;
    ledger.sync_all().map_err(storage)?;
    Ok(())
}
