//! Catalog the Android receiver's completed, app-private files without exporting
//! filesystem paths or depending on in-memory transfer receipts.

use std::{
    collections::BTreeMap,
    fs::{self, DirEntry},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use aerift_transfer::{ErrorCode, TransferError};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub(crate) const ID_PREFIX: &str = "received-";
const LIMIT: usize = 256;
const MAX_SIZE: u64 = (1 << 53) - 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReceivedFile {
    id: String,
    name: String,
    size_bytes: u64,
}

fn id_for_name(name: &str) -> String {
    let mut sha = Sha256::new();
    sha.update(b"aerift:android:received:v1\0");
    sha.update(name.as_bytes());
    format!("{ID_PREFIX}{:x}", sha.finalize())
}

fn name(entry: &DirEntry) -> Option<String> {
    let name = entry.file_name().into_string().ok()?;
    // The receiver publishes a validated filename (optionally with an integer
    // collision suffix). Never display hidden paths or partial-file names.
    (!name.starts_with(['.', ' '])
        && !name.trim().is_empty()
        && !name.chars().any(|ch| ch.is_control() || matches!(ch, '/' | '\\')))
        .then_some(name)
}

fn verified_entry(root: &Path, entry: &DirEntry) -> Option<(PathBuf, fs::Metadata)> {
    let candidate = entry.path();
    let metadata = fs::symlink_metadata(&candidate).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SIZE {
        return None;
    }
    let path = candidate.canonicalize().ok()?;
    (path.parent() == Some(root)).then_some((path, metadata))
}

pub(crate) fn list(root: &Path) -> Result<Vec<ReceivedFile>, TransferError> {
    let root = root.canonicalize().map_err(|_| ErrorCode::StorageFailed)?;
    let mut recent = BTreeMap::new();
    for entry in fs::read_dir(&root).map_err(|_| ErrorCode::StorageFailed)?.flatten() {
        let Some(name) = name(&entry) else { continue; };
        let Some((_, metadata)) = verified_entry(&root, &entry) else { continue; };
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        recent.insert((modified, name), metadata.len());
        if recent.len() > LIMIT {
            recent.pop_first();
        }
    }
    Ok(recent.into_iter().rev().map(|((_, name), size_bytes)| ReceivedFile {
        id: id_for_name(&name),
        name,
        size_bytes,
    }).collect())
}

pub(crate) fn resolve(root: &Path, id: &str) -> Result<(PathBuf, String), TransferError> {
    if !id.strip_prefix(ID_PREFIX).is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    }) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let root = root.canonicalize().map_err(|_| ErrorCode::StorageFailed)?;
    for entry in fs::read_dir(&root).map_err(|_| ErrorCode::StorageFailed)?.flatten() {
        let Some(name) = name(&entry) else { continue; };
        if id_for_name(&name) == id {
            if let Some((path, _)) = verified_entry(&root, &entry) {
                return Ok((path, name));
            }
        }
    }
    Err(ErrorCode::InvalidRequest.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::FileTimes, time::Duration};

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reopening_catalog_preserves_ids_and_exposes_neither_path_nor_staging() {
        let temporary = Temp::new();
        let published = temporary.0.join("published");
        fs::create_dir(&published).unwrap();
        fs::write(published.join("received.txt"), b"abc").unwrap();
        fs::write(published.join(".aerift-part-leftover"), b"pending").unwrap();
        fs::create_dir(published.join("folder")).unwrap();
        let retrieved = list(&published).unwrap();
        assert_eq!(retrieved.len(), 1);
        let serialized = serde_json::to_value(&retrieved[0]).unwrap();
        assert_eq!(serialized, serde_json::json!({
            "id": retrieved[0].id, "name": "received.txt", "sizeBytes": 3,
        }));
        let id = &retrieved[0].id;
        assert_eq!(list(&published).unwrap()[0].id, *id);
        assert_eq!(resolve(&published, id).unwrap().1, "received.txt");
        assert!(resolve(&published, "../received.txt").is_err());
    }

    #[test]
    fn catalog_rejects_symlinks_and_escapes_even_with_a_known_id() {
        let temporary = Temp::new();
        let published = temporary.0.join("published");
        fs::create_dir(&published).unwrap();
        let private = temporary.0.join("private.txt");
        fs::write(&private, b"private").unwrap();
        std::os::unix::fs::symlink(private, published.join("alias.txt")).unwrap();
        assert!(list(&published).unwrap().is_empty());
        assert!(resolve(&published, &id_for_name("alias.txt")).is_err());
    }

    #[test]
    fn catalog_caps_latest_files_and_larger_ordering_is_stable() {
        let root = Temp::new();
        for index in 0..(LIMIT as u64 + 2) {
            let file = fs::File::create(root.0.join(format!("file-{index}.txt"))).unwrap();
            file.set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(index + 1))).unwrap();
        }
        let files = list(&root.0).unwrap();
        assert_eq!(files.len(), LIMIT);
        assert_eq!(files[0].name, format!("file-{}.txt", LIMIT + 1));
        assert_eq!(files.last().unwrap().name, "file-2.txt");
    }
}
