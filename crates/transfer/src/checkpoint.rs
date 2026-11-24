//! A bounded, receiver-owned checkpoint for one consented upload.
//!
//! This deliberately does not manage consent, quotas, publishing, or restart
//! persistence. A trusted caller serializes access and disposes of the checkpoint
//! on cancellation, revocation, or expiry. Run these blocking methods on a
//! bounded blocking worker, not on an asynchronous request executor.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

pub const MAX_BLOCK: usize = 1024 * 1024;
const HASH_BUFFER: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Interrupted,
    InvalidRange,
    PrefixMismatch,
    BlockDigest,
    FileDigest,
    Incomplete,
    Storage,
}

pub struct Checkpoint {
    stage: NamedTempFile,
    expected_len: u64,
    expected_digest: [u8; 32],
    committed: u64,
    unusable: bool,
}

impl Checkpoint {
    /// Create a new unpublished stage in a receiver-controlled directory.
    pub fn create(
        directory: &Path,
        expected_len: u64,
        expected_digest: [u8; 32],
    ) -> Result<Self, Error> {
        let stage = tempfile::Builder::new()
            .prefix(".aerift-resume-part-")
            .tempfile_in(directory)
            .map_err(|_| Error::Storage)?;
        Ok(Self {
            stage,
            expected_len,
            expected_digest,
            committed: 0,
            unusable: false,
        })
    }

    pub fn offset(&self) -> u64 {
        self.committed
    }

    /// Append exactly `len` bytes from a transport-framed block.
    ///
    /// The caller enforces exact transport body length and caps any upstream
    /// buffering; this method does not consume bytes beyond the named block.
    /// Retries wholly within the prefix are validated against storage but never
    /// written. A failed or incomplete block does not advance the offset.
    pub fn append(
        &mut self,
        start: u64,
        len: usize,
        block_digest: [u8; 32],
        reader: &mut impl Read,
    ) -> Result<u64, Error> {
        if self.unusable {
            return Err(Error::Storage);
        }
        if len == 0 || len > MAX_BLOCK || start > self.committed {
            return Err(Error::InvalidRange);
        }
        let end = start.checked_add(len as u64).ok_or(Error::InvalidRange)?;
        if end > self.expected_len || (start < self.committed && end > self.committed) {
            return Err(Error::InvalidRange);
        }

        let mut bytes = vec![0_u8; len];
        reader
            .read_exact(&mut bytes)
            .map_err(|_| Error::Interrupted)?;
        if !digest_matches(Sha256::digest(&bytes), block_digest) {
            return Err(Error::BlockDigest);
        }

        let file = self.stage.as_file_mut();
        if file.metadata().map_err(|_| Error::Storage)?.len() != self.committed {
            self.unusable = true;
            return Err(Error::Storage);
        }
        file.seek(SeekFrom::Start(start))
            .map_err(|_| Error::Storage)?;
        if start < self.committed {
            return if digest_matches(hash_exact(file, len as u64)?, block_digest) {
                Ok(self.committed)
            } else {
                Err(Error::PrefixMismatch)
            };
        }
        if file.write_all(&bytes).and_then(|()| file.flush()).is_err() {
            // If there may be an uncommitted suffix and rollback fails,
            // refuse future writes and publication; Drop cleans the stage.
            if file.set_len(self.committed).is_err() {
                self.unusable = true;
            }
            return Err(Error::Storage);
        }
        self.committed = end;
        Ok(end)
    }

    /// Rehash and synchronize the whole stage, without publishing it.
    /// The returned handle still belongs to the receiver's publication gate.
    pub fn finish(mut self) -> Result<NamedTempFile, Error> {
        if self.unusable {
            return Err(Error::Storage);
        }
        if self.committed != self.expected_len {
            return Err(Error::Incomplete);
        }
        let file = self.stage.as_file_mut();
        if file.metadata().map_err(|_| Error::Storage)?.len() != self.expected_len {
            return Err(Error::FileDigest);
        }
        file.seek(SeekFrom::Start(0)).map_err(|_| Error::Storage)?;
        if !digest_matches(hash_exact(file, self.expected_len)?, self.expected_digest) {
            return Err(Error::FileDigest);
        }
        file.sync_all().map_err(|_| Error::Storage)?;
        file.seek(SeekFrom::Start(0)).map_err(|_| Error::Storage)?;
        Ok(self.stage)
    }
}

fn digest_matches(actual: sha2::digest::Output<Sha256>, expected: [u8; 32]) -> bool {
    let actual: [u8; 32] = actual.into();
    actual == expected
}

fn hash_exact(file: &mut File, mut length: u64) -> Result<sha2::digest::Output<Sha256>, Error> {
    let mut hash = Sha256::new();
    let mut buffer = vec![0; HASH_BUFFER];
    while length != 0 {
        let size = length.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..size])
            .map_err(|_| Error::Storage)?;
        hash.update(&buffer[..size]);
        length -= size as u64;
    }
    Ok(hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::{self, Cursor, Read};

    fn hash(data: &[u8]) -> [u8; 32] {
        Sha256::digest(data).into()
    }
    fn append(c: &mut Checkpoint, start: u64, bytes: &[u8]) -> Result<u64, Error> {
        c.append(start, bytes.len(), hash(bytes), &mut Cursor::new(bytes))
    }

    #[test]
    fn disconnect_after_commit_and_lost_ack_retries_only_uncommitted_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = Checkpoint::create(dir.path(), 6, hash(b"abcdef")).unwrap();
        assert_eq!(append(&mut c, 0, b"abc"), Ok(3));
        assert_eq!(append(&mut c, 0, b"abc"), Ok(3)); // lost response
        assert_eq!(append(&mut c, 0, b"Abc"), Err(Error::PrefixMismatch));
        assert_eq!(
            c.append(3, 3, hash(b"def"), &mut Cursor::new(b"de")),
            Err(Error::Interrupted)
        );
        assert_eq!(c.offset(), 3);
        assert_eq!(append(&mut c, 3, b"def"), Ok(6));
        assert_eq!(
            std::fs::read(c.finish().unwrap().path()).unwrap(),
            b"abcdef"
        );
    }

    #[test]
    fn invalid_bounds_and_digest_do_not_advance_state_or_read_input() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = Checkpoint::create(dir.path(), 6, hash(b"abcdef")).unwrap();
        assert_eq!(append(&mut c, 0, b"abc"), Ok(3));
        struct NeverRead;
        impl Read for NeverRead {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                panic!("invalid bounds must be rejected before reading a body")
            }
        }
        for (start, len) in [
            (4, 1),
            (2, 2),
            (3, 4),
            (3, 0),
            (3, MAX_BLOCK + 1),
            (u64::MAX, 1),
        ] {
            assert_eq!(
                c.append(start, len, hash(b""), &mut NeverRead),
                Err(Error::InvalidRange)
            );
        }
        assert_eq!(
            c.append(3, 3, hash(b"def"), &mut Cursor::new(b"deg")),
            Err(Error::BlockDigest)
        );
        assert_eq!(c.offset(), 3);
    }

    #[test]
    fn fully_written_stage_requires_manifest_rehash_before_being_returned() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = Checkpoint::create(dir.path(), 6, hash(b"abcdef")).unwrap();
        assert_eq!(append(&mut c, 0, b"abc"), Ok(3));
        assert_eq!(append(&mut c, 3, b"deg"), Ok(6));
        assert_eq!(c.finish().unwrap_err(), Error::FileDigest);
    }

    #[test]
    fn zero_byte_file_is_supported_and_unfinished_file_is_not_published() {
        let dir = tempfile::tempdir().unwrap();
        let c = Checkpoint::create(dir.path(), 1, hash(b"a")).unwrap();
        assert_eq!(c.finish().unwrap_err(), Error::Incomplete);
        let c = Checkpoint::create(dir.path(), 0, hash(b"")).unwrap();
        assert_eq!(
            std::fs::metadata(c.finish().unwrap().path()).unwrap().len(),
            0
        );
    }
}
