//! Opt-in Unix crash-recovery storage for private, approved receiving stages.
//! The enclosing Receiver performs peer authorization and fresh local approval.
use std::{
    fs::{self, File, OpenOptions, Permissions},
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};

use crate::{
    ErrorCode, Offer, PeerId, RESUMABLE_CHUNK_SIZE, TransferError, TransferKey, model::safe_name,
};

const VERSION: u8 = 1;
const RECORD_LIMIT: u64 = 16 * 1024;
const TTL_SECONDS: u64 = 30 * 60;

#[derive(Clone)]
pub(crate) struct Journal(Arc<JournalRoot>);

struct JournalRoot {
    path: PathBuf,
    quota: u64,
    slots: usize,
    _owner: File,
    mutation: Mutex<()>,
}

impl Drop for JournalRoot {
    fn drop(&mut self) {
        // Closing an FD alone can temporarily leave a flock held by a child
        // between fork and exec. Release it while this known owner still holds
        // the authoritative file handle; accidental inherited FDs own no state.
        let _ = self._owner.unlock();
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    peer: PeerId,
    offer: Offer,
    offset: u64,
    prefix_digest: String,
    expires: u64,
    target: Option<String>,
    published: bool,
}

pub(crate) struct DurableCheckpoint {
    directory: PathBuf,
    stage: File,
    record: Record,
    prefix: Sha256,
    // An in-flight finalize must keep this exclusive journal lock alive.
    journal: Journal,
}

impl Journal {
    pub(crate) fn open(path: &Path, quota: u64, slots: usize) -> Result<Self, TransferError> {
        let metadata = fs::symlink_metadata(path).map_err(storage)?;
        if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 || slots == 0 {
            return Err(ErrorCode::StorageFailed.into());
        }
        let path = path.canonicalize().map_err(storage)?;
        let lock_path = path.join("owner.lock");
        if let Ok(metadata) = fs::symlink_metadata(&lock_path)
            && !metadata.is_file()
        {
            return Err(ErrorCode::StorageFailed.into());
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(lock_path)
            .map_err(storage)?;
        lock.try_lock().map_err(|_| ErrorCode::Conflict)?;
        let journal = Self(Arc::new(JournalRoot {
            path,
            quota,
            slots,
            _owner: lock,
            mutation: Mutex::new(()),
        }));
        // A crash before publication of a new record may leave only a
        // temporary creation directory. It has never reserved a transfer ID.
        for item in fs::read_dir(&journal.0.path).map_err(storage)? {
            let item = item.map_err(storage)?;
            if item
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(".new-"))
            {
                journal.discard_directory(&item.path())?;
            }
        }
        journal.reap_and_usage()?;
        Ok(journal)
    }

    // A previous checkpoint gives no authority until a fresh local accept.
    pub(crate) fn inspect(&self, key: TransferKey, offer: &Offer) -> Result<(), TransferError> {
        if let Some(record) = self.read_for(key)? {
            verify_record(&record, key, offer)?;
        }
        Ok(())
    }

    pub(crate) fn approve(
        &self,
        key: TransferKey,
        offer: &Offer,
    ) -> Result<DurableCheckpoint, TransferError> {
        let _lock = self.0.mutation.lock().map_err(storage)?;
        if key.id != offer.id {
            return Err(ErrorCode::InvalidRequest.into());
        }
        offer.validate()?;
        let directory = self.directory(key);
        let record = if let Some(record) = self.read_for(key)? {
            verify_record(&record, key, offer)?;
            record
        } else {
            let (slots, bytes) = self.reap_and_usage()?;
            if slots >= self.0.slots || offer.size_bytes > self.0.quota.saturating_sub(bytes) {
                return Err(ErrorCode::StorageFailed.into());
            }
            let record = Record {
                version: VERSION,
                peer: key.peer,
                offer: offer.clone(),
                offset: 0,
                prefix_digest: digest(&Sha256::new()),
                expires: time_now()?.saturating_add(TTL_SECONDS),
                target: None,
                published: false,
            };
            let temporary = tempfile::Builder::new()
                .prefix(".new-")
                .permissions(Permissions::from_mode(0o700))
                .tempdir_in(&self.0.path)
                .map_err(storage)?;
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(temporary.path().join("stage"))
                .map_err(storage)?;
            file.sync_all().map_err(storage)?;
            write_record(temporary.path(), &record)?;
            fs::rename(temporary.path(), &directory).map_err(storage)?;
            sync_dir(&self.0.path)?;
            record
        };
        let stage_path = directory.join("stage");
        verify_file(&stage_path)?;
        let mut stage = OpenOptions::new()
            .read(true)
            .write(true)
            .open(stage_path)
            .map_err(storage)?;
        let len = stage.metadata().map_err(storage)?.len();
        if len < record.offset || (record.target.is_some() && len != record.offset) {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        let prefix = rehash(&mut stage, record.offset)?;
        if digest(&prefix) != record.prefix_digest {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        if len > record.offset {
            // power loss between data sync and journal sync
            stage.set_len(record.offset).map_err(storage)?;
            stage.sync_all().map_err(storage)?;
        }
        Ok(DurableCheckpoint {
            directory,
            stage,
            record,
            prefix,
            journal: self.clone(),
        })
    }

    pub(crate) fn discard(&self, key: TransferKey) -> Result<(), TransferError> {
        let _lock = self.0.mutation.lock().map_err(storage)?;
        self.discard_directory(&self.directory(key))
    }

    pub(crate) fn discard_peer(&self, peer: PeerId) -> Result<(), TransferError> {
        let _lock = self.0.mutation.lock().map_err(storage)?;
        let prefix = format!("{peer}-");
        for item in fs::read_dir(&self.0.path).map_err(storage)? {
            let item = item.map_err(storage)?;
            let name = item.file_name();
            let Some(name) = name.to_str() else { continue };
            if name
                .strip_prefix(&prefix)
                .and_then(crate::parse_id)
                .is_some()
            {
                self.discard_directory(&item.path())?;
            }
        }
        Ok(())
    }

    fn discard_directory(&self, path: &Path) -> Result<(), TransferError> {
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() => {
                fs::remove_dir_all(path).map_err(storage)?;
                sync_dir(&self.0.path)
            }
            Ok(_) => Err(ErrorCode::StorageFailed.into()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(storage(err)),
        }
    }

    fn directory(&self, key: TransferKey) -> PathBuf {
        self.0.path.join(format!("{}-{}", key.peer, key.id))
    }

    fn read_for(&self, key: TransferKey) -> Result<Option<Record>, TransferError> {
        let dir = self.directory(key);
        match fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() && meta.permissions().mode() & 0o077 == 0 => {
                read_record(&dir).map(Some)
            }
            Ok(_) => Err(ErrorCode::StorageFailed.into()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(storage(err)),
        }
    }

    // Storage is trusted/private, but on malformed records fail closed rather
    // than writing around unknown staged data. At most slots records are live.
    fn reap_and_usage(&self) -> Result<(usize, u64), TransferError> {
        let now = time_now()?;
        let mut slots = 0_usize;
        let mut bytes = 0_u64;
        for item in fs::read_dir(&self.0.path).map_err(storage)? {
            let item = item.map_err(storage)?;
            let name = item.file_name();
            let Some(name) = name.to_str() else { continue };
            if name == "owner.lock" {
                continue;
            }
            let (peer, uuid) = name.split_once('-').ok_or(ErrorCode::StorageFailed)?;
            let key = TransferKey {
                peer: peer.parse()?,
                id: crate::parse_id(uuid).ok_or(ErrorCode::InvalidRequest)?,
            };
            let record = self.read_for(key)?.ok_or(ErrorCode::StorageFailed)?;
            if record.expires <= now {
                self.discard_directory(&item.path())?;
            } else {
                if record.version != VERSION || record.peer != key.peer || record.offer.id != key.id
                {
                    return Err(ErrorCode::IntegrityFailed.into());
                }
                record.offer.validate()?;
                slots = slots.saturating_add(1);
                bytes = bytes.saturating_add(record.offer.size_bytes);
            }
        }
        Ok((slots, bytes))
    }
}

impl DurableCheckpoint {
    pub(crate) fn discard(&self) -> Result<(), TransferError> {
        self.journal.discard(TransferKey {
            peer: self.record.peer,
            id: self.record.offer.id,
        })
    }

    pub(crate) fn offset(&self) -> u64 {
        self.record.offset
    }

    #[cfg(test)]
    fn stage_path(&self) -> PathBuf {
        self.directory.join("stage")
    }

    pub(crate) fn append(&mut self, offset: u64, bytes: &[u8]) -> Result<u64, TransferError> {
        let _lock = self.journal.0.mutation.lock().map_err(storage)?;
        let max = RESUMABLE_CHUNK_SIZE as u64;
        let length = bytes.len() as u64;
        let end = offset
            .checked_add(length)
            .ok_or(ErrorCode::InvalidRequest)?;
        if self.record.published
            || self.record.target.is_some()
            || length == 0
            || length != self.record.offer.size_bytes.saturating_sub(offset).min(max)
            || !offset.is_multiple_of(max)
            || offset > self.record.offset
            || (offset < self.record.offset && end > self.record.offset)
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        if self.record.expires <= time_now()? {
            return Err(ErrorCode::PeerUnavailable.into());
        }
        if self.stage.metadata().map_err(storage)?.len() != self.record.offset {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        self.stage.seek(SeekFrom::Start(offset)).map_err(storage)?;
        if offset < self.record.offset {
            let mut committed = vec![0; bytes.len()];
            self.stage.read_exact(&mut committed).map_err(storage)?;
            return if committed == bytes {
                Ok(self.record.offset)
            } else {
                Err(ErrorCode::IntegrityFailed.into())
            };
        }
        self.stage
            .write_all(bytes)
            .and_then(|()| self.stage.sync_all())
            .map_err(storage)?;
        let mut prefix = self.prefix.clone();
        prefix.update(bytes);
        let record = Record {
            offset: end,
            prefix_digest: digest(&prefix),
            expires: time_now()?.saturating_add(TTL_SECONDS),
            ..self.record.clone()
        };
        write_record(&self.directory, &record)?;
        self.record = record;
        self.prefix = prefix;
        Ok(end)
    }

    // Return true only with actual stage/destination inode provenance, not merely
    // a filename or equal hash that could be a pre-existing unrelated file.
    fn linked(&self, target: &Path) -> Result<bool, TransferError> {
        match fs::symlink_metadata(target) {
            Ok(target) if target.is_file() => {
                let stage = self.stage.metadata().map_err(storage)?;
                Ok(stage.dev() == target.dev() && stage.ino() == target.ino())
            }
            Ok(_) => Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(storage(error)),
        }
    }

    pub(crate) fn verify_complete(&mut self) -> Result<(), TransferError> {
        if self.record.offset != self.record.offer.size_bytes
            || self.stage.metadata().map_err(storage)?.len() != self.record.offset
            || digest(&rehash(&mut self.stage, self.record.offset)?) != self.record.offer.sha256
        {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        Ok(())
    }

    pub(crate) fn publish_verified(
        &mut self,
        destination: &Path,
        authorized: impl Fn() -> bool,
    ) -> Result<PathBuf, TransferError> {
        let _lock = self.journal.0.mutation.lock().map_err(storage)?;
        if !authorized() {
            return Err(ErrorCode::Cancelled.into());
        }
        if !self.linked(&self.directory.join("stage"))? || self.record.expires <= time_now()? {
            return Err(ErrorCode::IntegrityFailed.into());
        }
        if let Some(name) = &self.record.target {
            // Only a derived single path can ever be persisted or recovered.
            let path = destination.join(name);
            if self.linked(&path)? {
                sync_dir(destination)?;
                if !self.record.published {
                    self.record.published = true;
                    write_record(&self.directory, &self.record)?;
                }
                return Ok(path);
            }
            if self.record.published {
                return Err(ErrorCode::IntegrityFailed.into());
            }
        }
        for index in 0..1000 {
            let name = if index == 0 {
                self.record.offer.name.clone()
            } else {
                format!("{index}-{}", self.record.offer.name)
            };
            let path = destination.join(&name);
            if path.exists() {
                continue;
            }
            self.record.target = Some(name);
            write_record(&self.directory, &self.record)?;
            if !authorized() {
                return Err(ErrorCode::Cancelled.into());
            }
            match fs::hard_link(self.directory.join("stage"), &path) {
                Ok(()) => {
                    sync_dir(destination)?;
                    self.record.published = true;
                    write_record(&self.directory, &self.record)?;
                    return Ok(path);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(storage(error)),
            }
        }
        Err(ErrorCode::Conflict.into())
    }
}

fn read_record(directory: &Path) -> Result<Record, TransferError> {
    let path = directory.join("record.json");
    verify_file(&path)?;
    let mut buffer = Vec::new();
    File::open(path)
        .map_err(storage)?
        .take(RECORD_LIMIT + 1)
        .read_to_end(&mut buffer)
        .map_err(storage)?;
    if buffer.len() as u64 > RECORD_LIMIT {
        return Err(ErrorCode::StorageFailed.into());
    }
    serde_json::from_slice(&buffer).map_err(storage)
}

fn write_record(directory: &Path, record: &Record) -> Result<(), TransferError> {
    let mut new = tempfile::Builder::new()
        .prefix(".record-")
        .tempfile_in(directory)
        .map_err(storage)?;
    serde_json::to_writer(new.as_file_mut(), record).map_err(storage)?;
    new.as_file().sync_all().map_err(storage)?;
    new.persist(directory.join("record.json"))
        .map_err(storage)?;
    sync_dir(directory)
}

fn verify_record(record: &Record, key: TransferKey, offer: &Offer) -> Result<(), TransferError> {
    let max = RESUMABLE_CHUNK_SIZE as u64;
    if record.version != VERSION
        || record.peer != key.peer
        || record.offer.id != key.id
        || record.offer != *offer
        || record.offset > offer.size_bytes
        || (record.offset != offer.size_bytes && !record.offset.is_multiple_of(max))
        || (record.published && record.target.is_none())
        || record
            .target
            .as_ref()
            .is_some_and(|name| !is_target_name(name, &record.offer.name))
    {
        return Err(ErrorCode::IntegrityFailed.into());
    }
    if record.expires <= time_now()? {
        return Err(ErrorCode::PeerUnavailable.into());
    }
    Ok(())
}

fn is_target_name(name: &str, original: &str) -> bool {
    if !safe_name(original) {
        return false;
    }
    if name == original {
        return true;
    }
    name.split_once('-').is_some_and(|(prefix, suffix)| {
        suffix == original
            && prefix
                .parse::<u16>()
                .is_ok_and(|index| (1..1000).contains(&index) && index.to_string() == prefix)
    })
}

fn verify_file(path: &Path) -> Result<(), TransferError> {
    if !fs::symlink_metadata(path).map_err(storage)?.is_file() {
        return Err(ErrorCode::StorageFailed.into());
    }
    Ok(())
}

fn rehash(file: &mut File, mut remaining: u64) -> Result<Sha256, TransferError> {
    file.seek(SeekFrom::Start(0)).map_err(storage)?;
    let mut data = [0_u8; 65536];
    let mut hash = Sha256::new();
    while remaining > 0 {
        let count = remaining.min(data.len() as u64) as usize;
        file.read_exact(&mut data[..count]).map_err(storage)?;
        hash.update(&data[..count]);
        remaining -= count as u64;
    }
    Ok(hash)
}

fn digest(hash: &Sha256) -> String {
    format!("{:x}", hash.clone().finalize())
}
fn sync_dir(path: &Path) -> Result<(), TransferError> {
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(storage)
}
fn time_now() -> Result<u64, TransferError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(storage)
}
fn storage(_: impl Sized) -> TransferError {
    ErrorCode::StorageFailed.into()
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Offer, PeerId, TransferKey};
    use sha2::{Digest, Sha256};
    use uuid::Uuid;
    const QUOTA: u64 = 8 * 1024 * 1024;

    #[test]
    fn crash_after_link_requires_inode_proof_and_does_not_write_duplicate() {
        let root = tempfile::Builder::new()
            .permissions(Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let dest = tempfile::tempdir_in(root.path().parent().unwrap()).unwrap();
        let peer = PeerId::from_tls_leaf(b"peer approved");
        let key = TransferKey {
            peer,
            id: Uuid::new_v4(),
        };
        let data = b"only once";
        let offer = Offer {
            id: key.id,
            name: "fixture.bin".into(),
            size_bytes: data.len() as u64,
            sha256: format!("{:x}", Sha256::digest(data)),
        };
        {
            let store = Journal::open(root.path(), QUOTA, 10).unwrap();
            assert_eq!(
                Journal::open(root.path(), QUOTA, 10).err().unwrap().code,
                ErrorCode::Conflict
            );
            let mut cp = store.approve(key, &offer).unwrap();
            cp.append(0, data).unwrap();
            cp.record.target = Some(offer.name.clone());
            write_record(&cp.directory, &cp.record).unwrap();
            fs::hard_link(cp.stage_path(), dest.path().join(&offer.name)).unwrap();
            assert!(!cp.record.published);
        }
        let store = Journal::open(root.path(), QUOTA, 10).unwrap();
        let mut checkpoint = store.approve(key, &offer).unwrap();
        checkpoint.verify_complete().unwrap();
        assert!(checkpoint.publish_verified(dest.path(), || false).is_err());
        assert_eq!(
            checkpoint.publish_verified(dest.path(), || true).unwrap(),
            dest.path().join(&offer.name)
        );
        assert!(!dest.path().join("1-fixture.bin").exists());
        assert_eq!(fs::read(dest.path().join(&offer.name)).unwrap(), data);
    }

    #[test]
    fn tampered_prefix_fails_closed_after_reopening() {
        let root = tempfile::Builder::new()
            .permissions(Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let peer = PeerId::from_tls_leaf(b"peer approved");
        let key = TransferKey {
            peer,
            id: Uuid::new_v4(),
        };
        let data = b"only expected bytes";
        let offer = Offer {
            id: key.id,
            name: "fixture.bin".into(),
            size_bytes: data.len() as u64,
            sha256: format!("{:x}", Sha256::digest(data)),
        };
        {
            let store = Journal::open(root.path(), QUOTA, 10).unwrap();
            let mut cp = store.approve(key, &offer).unwrap();
            cp.append(0, data).unwrap();
            fs::write(cp.stage_path(), vec![88; data.len()]).unwrap();
        }
        let store = Journal::open(root.path(), QUOTA, 10).unwrap();
        let other = TransferKey {
            peer: PeerId::from_tls_leaf(b"different peer"),
            id: key.id,
        };
        let other_cp = store.approve(other, &offer).unwrap();
        assert_eq!(other_cp.offset(), 0);
        assert_eq!(
            store.approve(key, &offer).err().unwrap().code,
            ErrorCode::IntegrityFailed
        );
    }

    #[test]
    fn restart_revalidates_manifest_prefix_and_never_promotes_unrecorded_tail() {
        let temp = tempfile::Builder::new()
            .permissions(Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let key = TransferKey {
            peer: PeerId::from_tls_leaf(b"peer-a"),
            id: Uuid::new_v4(),
        };
        let block = vec![0x62; crate::RESUMABLE_CHUNK_SIZE];
        let mut data = block.clone();
        data.extend_from_slice(b"tail");
        let offer = Offer {
            id: key.id,
            name: "fixture.bin".into(),
            size_bytes: data.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&data)),
        };
        {
            let store = Journal::open(temp.path(), QUOTA, 10).unwrap();
            let mut checkpoint = store.approve(key, &offer).unwrap();
            assert_eq!(checkpoint.append(0, &block).unwrap(), block.len() as u64);
            use std::io::Write;
            std::fs::OpenOptions::new()
                .append(true)
                .open(checkpoint.stage_path())
                .unwrap()
                .write_all(b"bad crash tail")
                .unwrap();
        }
        let store = Journal::open(temp.path(), QUOTA, 10).unwrap();
        assert!(store.inspect(key, &offer).is_ok());
        let mut changed = offer.clone();
        changed.name = "changed.bin".into();
        assert!(store.approve(key, &changed).is_err());
        let mut checkpoint = store.approve(key, &offer).unwrap();
        assert_eq!(checkpoint.offset(), block.len() as u64);
        assert_eq!(
            std::fs::metadata(checkpoint.stage_path()).unwrap().len(),
            block.len() as u64
        );
        assert_eq!(
            checkpoint.append(block.len() as u64, b"tail").unwrap(),
            data.len() as u64
        );
    }
}
