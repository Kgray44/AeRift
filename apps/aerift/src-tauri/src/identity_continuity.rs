//! Platform path evidence only. Never read or write private key bytes here.
use std::{fs, io, path::Path};

const DEVICE_BOUND_RECORDS: &[&str] = &[
    "trust.dpapi",
    "remote-trust-v1.dpapi",
    "friends-v1/book.dpapi",
    "friends-member-v1/book.dpapi",
];

pub(super) fn require_fresh_device_profile(root: &Path) -> io::Result<()> {
    for name in DEVICE_BOUND_RECORDS {
        match fs::symlink_metadata(root.join(name)) {
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "Existing grant state requires identity recovery",
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
