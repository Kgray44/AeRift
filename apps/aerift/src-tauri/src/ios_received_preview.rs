//! Read-only preview of a verified completed iOS receipt.
//! Never bind a caller-provided path or feed Documents/Received to Quick Look.
use std::{
    ffi::CString,
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    },
    path::{Component, Path},
};

use aerift_transfer::{ErrorCode, IncomingTransfer, State, TransferError};
use sha2::{Digest, Sha256};

const MAX_TEXT: u64 = 64 * 1024;

pub(crate) fn receipt_key(id: &str) -> Result<aerift_transfer::TransferKey, TransferError> {
    if id.len() != 101 || !id.is_ascii() {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let (peer_text, transfer) = id.split_once(':').ok_or(ErrorCode::InvalidRequest)?;
    let peer = peer_text.parse().map_err(|_| ErrorCode::InvalidRequest)?;
    let id = transfer.parse().map_err(|_| ErrorCode::InvalidRequest)?;
    if format!("{peer}:{id}") != format!("{peer_text}:{transfer}") {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(aerift_transfer::TransferKey { peer, id })
}

/// The caller resolves the opaque receipt ID in Session's live Receiver,
/// enforces main-window scope and runs on an I/O worker. Unsupported content
/// gets metadata only. Files visible to Apple Files remain untouched.
pub(crate) fn text(
    published: &Path,
    receipt: &IncomingTransfer,
) -> Result<Option<String>, TransferError> {
    let path = receipt
        .saved_path
        .as_ref()
        .ok_or(ErrorCode::InvalidRequest)?;
    if receipt.status.state != State::Completed
        || receipt.status.error.is_some()
        || receipt.status.bytes_transferred != receipt.offer.size_bytes
        || path.parent() != Some(published)
    {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let name = path.file_name().ok_or(ErrorCode::InvalidRequest)?;
    verified_text(
        published,
        &receipt.offer.name,
        Path::new(name),
        receipt.offer.size_bytes,
        &receipt.offer.sha256,
    )
}

pub(crate) fn verified_text(
    published: &Path,
    name: &str,
    leaf: &Path,
    size: u64,
    digest: &str,
) -> Result<Option<String>, TransferError> {
    let allowed = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ["txt", "md", "csv", "json", "log"]
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
        });
    if !allowed || size > MAX_TEXT {
        return Ok(None);
    }
    let bytes = read_verified(published, leaf, size, digest)?;
    Ok(String::from_utf8(bytes).ok().filter(|text| {
        !text
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\t' | '\r' | '\n'))
    }))
}

pub(crate) fn exists_at_size(published: &Path, leaf: &Path, size: u64) -> bool {
    open_owned(published, leaf, size).is_ok()
}

fn read_verified(
    published: &Path,
    leaf: &Path,
    size: u64,
    digest: &str,
) -> Result<Vec<u8>, TransferError> {
    if size > MAX_TEXT {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let file = open_owned(published, leaf, size)?;
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ErrorCode::StorageFailed)?;
    if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err(ErrorCode::IntegrityFailed.into());
    }
    Ok(bytes)
}

fn open_owned(published: &Path, leaf: &Path, size: u64) -> Result<File, TransferError> {
    let mut components = leaf.components();
    let Some(Component::Normal(leaf)) = components.next() else {
        return Err(ErrorCode::InvalidRequest.into());
    };
    if components.next().is_some() {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let leaf = CString::new(leaf.as_bytes()).map_err(|_| ErrorCode::InvalidRequest)?;
    // published is an OS-established app container location, not an IPC arg.
    // O_NOFOLLOW rejects a replaced Received directory; the opened FD then
    // pins that directory against later rename/replacement during leaf lookup.
    let dir = File::options()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(published)
        .map_err(|_| ErrorCode::StorageFailed)?;
    // A nonblocking open prevents a replaced FIFO from hanging the I/O worker.
    // SAFETY: dir is alive, leaf is NUL terminated and flags do not create a file.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            leaf.as_ptr(),
            libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(ErrorCode::StorageFailed.into());
    }
    // SAFETY: openat returned a newly owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    let meta = file.metadata().map_err(|_| ErrorCode::StorageFailed)?;
    if !meta.is_file() || meta.len() != size {
        return Err(ErrorCode::IntegrityFailed.into());
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    const ORIGINAL: &[u8] = b"<test>plain text, not markup</test>";

    #[test]
    fn only_canonical_composite_receipt_keys_are_accepted() {
        let id = format!("{}:c6991e6c-ecd2-4f10-905c-0f254040dda7", "a".repeat(64));
        assert!(receipt_key(&id).is_ok());
        assert!(receipt_key(&id.to_uppercase()).is_err());
        assert!(receipt_key("notes.txt").is_err());
        assert!(receipt_key(&format!("{id}:stale")).is_err());
    }

    #[test]
    fn returns_bytes_from_same_handle_verified_against_receipt() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), ORIGINAL).unwrap();
        let digest = format!("{:x}", Sha256::digest(ORIGINAL));
        assert_eq!(
            read_verified(
                root.path(),
                Path::new("one.txt"),
                ORIGINAL.len() as u64,
                &digest
            )
            .unwrap(),
            ORIGINAL
        );
        fs::write(root.path().join("one.txt"), vec![b'x'; ORIGINAL.len()]).unwrap();
        assert!(read_verified(
            root.path(),
            Path::new("one.txt"),
            ORIGINAL.len() as u64,
            &digest
        )
        .is_err());
    }

    #[test]
    fn rejects_redirects_nonleaf_and_oversize() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        let redirected = root.path().join("redirected");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("one.txt"), ORIGINAL).unwrap();
        symlink(&real, &redirected).unwrap();
        symlink(real.join("one.txt"), real.join("alias.txt")).unwrap();
        let digest = format!("{:x}", Sha256::digest(ORIGINAL));
        for (dir, name) in [
            (&real, "alias.txt"),
            (&redirected, "one.txt"),
            (&real, "../real/one.txt"),
            (&real, "."),
        ] {
            assert!(read_verified(dir, Path::new(name), ORIGINAL.len() as u64, &digest).is_err());
        }
        assert!(read_verified(&real, Path::new("one.txt"), MAX_TEXT + 1, &digest).is_err());
    }
}
