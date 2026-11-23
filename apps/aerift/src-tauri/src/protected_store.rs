use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    slice,
};

use tempfile::NamedTempFile;
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};

const MAX_PLAINTEXT: usize = 1024 * 1024;
const MAX_BLOB: usize = MAX_PLAINTEXT + 64 * 1024;

pub(crate) struct ProtectedFile {
    directory: PathBuf,
    name: &'static str,
}

impl ProtectedFile {
    pub(crate) fn new(directory: &Path, name: &'static str) -> Self {
        Self {
            directory: directory.to_owned(),
            name,
        }
    }

    pub(crate) fn load(&self) -> io::Result<Option<Vec<u8>>> {
        let file = match File::open(self.directory.join(self.name)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut blob = Vec::new();
        file.take((MAX_BLOB + 1) as u64).read_to_end(&mut blob)?;
        if blob.is_empty() || blob.len() > MAX_BLOB {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid protected file",
            ));
        }
        transform(&blob, false).map(Some)
    }

    pub(crate) fn create_if_absent(&self, bytes: &[u8]) -> io::Result<bool> {
        let (staged, destination) = self.stage(bytes)?;
        match staged.persist_noclobber(destination) {
            Ok(_) => Ok(true),
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error.error),
        }
    }

    pub(crate) fn replace(&self, bytes: &[u8]) -> io::Result<()> {
        let (staged, destination) = self.stage(bytes)?;
        staged.persist(destination).map_err(|error| error.error)?;
        Ok(())
    }

    fn stage(&self, bytes: &[u8]) -> io::Result<(NamedTempFile, PathBuf)> {
        if bytes.is_empty() || bytes.len() > MAX_PLAINTEXT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid protected data",
            ));
        }
        let encrypted = transform(bytes, true)?;
        fs::create_dir_all(&self.directory)?;
        let mut staged = NamedTempFile::new_in(&self.directory)?;
        staged.write_all(&encrypted)?;
        staged.as_file().sync_all()?;
        Ok((staged, self.directory.join(self.name)))
    }
}

struct LocalBlob(CRYPT_INTEGER_BLOB);

impl Drop for LocalBlob {
    fn drop(&mut self) {
        if !self.0.pbData.is_null() {
            // DPAPI owns the allocation until the caller releases it with LocalFree.
            unsafe { LocalFree(self.0.pbData.cast()) };
        }
    }
}

fn transform(input: &[u8], encrypt: bool) -> io::Result<Vec<u8>> {
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut output = LocalBlob(CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    });

    // DPAPI reads source during the call and allocates output for this caller.
    // Omitting the machine flag binds the stored data to the current user.
    let succeeded = unsafe {
        if encrypt {
            CryptProtectData(
                &source,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
        } else {
            CryptUnprotectData(
                &source,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
        }
    };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }

    let limit = if encrypt { MAX_BLOB } else { MAX_PLAINTEXT };
    let length = output.0.cbData as usize;
    if output.0.pbData.is_null() || length == 0 || length > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid DPAPI output",
        ));
    }
    // DPAPI returned a readable buffer of this size, still owned by LocalBlob.
    let result = unsafe { slice::from_raw_parts(output.0.pbData, length).to_vec() };
    if !encrypt {
        // Clear the temporary native plaintext before returning the owned copy.
        for index in 0..length {
            unsafe { output.0.pbData.add(index).write_volatile(0) };
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_the_first_identity_and_recovers_it_from_disk() {
        let directory = tempfile::tempdir().unwrap();
        let first = ProtectedFile::new(directory.path(), "identity.dpapi");
        assert_eq!(first.load().unwrap(), None);
        assert!(first.create_if_absent(b"first identity").unwrap());
        assert!(!first.create_if_absent(b"second identity").unwrap());

        let ciphertext = fs::read(directory.path().join("identity.dpapi")).unwrap();
        assert!(!ciphertext
            .windows(b"first identity".len())
            .any(|part| part == b"first identity"));
        let reopened = ProtectedFile::new(directory.path(), "identity.dpapi");
        assert_eq!(
            reopened.load().unwrap().as_deref(),
            Some(b"first identity".as_slice())
        );
    }

    #[test]
    fn replaces_a_snapshot_and_rejects_invalid_ciphertext() {
        let directory = tempfile::tempdir().unwrap();
        let trust = ProtectedFile::new(directory.path(), "trust.dpapi");
        trust.replace(b"old trust").unwrap();
        trust.replace(b"new trust").unwrap();
        assert_eq!(
            trust.load().unwrap().as_deref(),
            Some(b"new trust".as_slice())
        );
        fs::write(directory.path().join("trust.dpapi"), b"invalid").unwrap();
        assert!(trust.load().is_err());
    }
}
