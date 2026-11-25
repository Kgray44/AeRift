//! Test-only Windows prototype: metadata from an already pinned directory.
//! No picker UI, path arguments, child opening, content or IPC.

#[path = "windows_directory_page_codec.rs"]
mod codec;

use super::PinnedDirectory;
use codec::{
    ATTRIBUTES_OFFSET, DirectoryEntryMetadata, ID_OFFSET, NAME_LENGTH_OFFSET, NAME_OFFSET,
    NEXT_OFFSET, NON_LOCAL_ATTRIBUTES, PAGE_BYTES, SIZE_OFFSET, parse_page,
};
use std::{
    io,
    mem::{offset_of, size_of},
    os::windows::io::AsRawHandle,
};
use windows_sys::Win32::{
    Foundation::{ERROR_HANDLE_EOF, ERROR_NO_MORE_FILES},
    Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_TAG_INFO, FILE_ID_EXTD_DIR_INFO,
        FileAttributeTagInfo, FileIdExtdDirectoryInfo, FileIdExtdDirectoryRestartInfo,
        GetFileInformationByHandleEx,
    },
};

const _: () = {
    assert!(offset_of!(FILE_ID_EXTD_DIR_INFO, NextEntryOffset) == NEXT_OFFSET);
    assert!(offset_of!(FILE_ID_EXTD_DIR_INFO, EndOfFile) == SIZE_OFFSET);
    assert!(offset_of!(FILE_ID_EXTD_DIR_INFO, FileAttributes) == ATTRIBUTES_OFFSET);
    assert!(offset_of!(FILE_ID_EXTD_DIR_INFO, FileNameLength) == NAME_LENGTH_OFFSET);
    assert!(offset_of!(FILE_ID_EXTD_DIR_INFO, FileId) == ID_OFFSET);
    assert!(offset_of!(FILE_ID_EXTD_DIR_INFO, FileName) == NAME_OFFSET);
};
const MAX_PAGES: u16 = 128;

#[repr(align(8))]
struct Buffer([u8; PAGE_BYTES]);

struct DirectoryPages {
    // Own the already trusted, pinned directory. The adapter must not share
    // its native enumeration cursor or treat a duplicated HANDLE as independent.
    held: Option<PinnedDirectory>,
    pages: u16,
}

impl DirectoryPages {
    fn new(directory: PinnedDirectory) -> Self {
        Self {
            held: Some(directory),
            pages: 0,
        }
    }

    fn next(&mut self) -> io::Result<Option<Vec<DirectoryEntryMetadata>>> {
        let Some(directory) = &self.held else {
            return Ok(None);
        };
        if self.pages == MAX_PAGES {
            self.held = None;
            return Err(io::Error::other("folder browsing page limit reached"));
        }
        let result = read_metadata_page(directory, self.pages == 0);
        self.pages += 1;
        if !matches!(result, Ok(Some(_))) {
            // Fail closed on an OS or record error. Drop pinned directory and
            // ancestors promptly on EOF, provider changes, or invalid pages.
            self.held = None;
        }
        result
    }
}

const GRANT_LIFETIME: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Debug)]
struct FolderReadEntry {
    name: String,
    size_bytes: Option<u64>,
}

#[derive(Debug)]
struct FolderReadPage {
    entries: Vec<FolderReadEntry>,
    next: Option<uuid::Uuid>,
}

// This candidate receives a trusted, already pinned directory. No path,
// Win32 handle or file ID can arrive through the request or leave a page.
struct FolderReadGrant {
    id: uuid::Uuid,
    expected: Option<uuid::Uuid>,
    expires: std::time::Instant,
    pages: Option<DirectoryPages>,
}

impl FolderReadGrant {
    fn new(root: PinnedDirectory) -> Self {
        Self {
            id: uuid::Uuid::new_v4(),
            expected: Some(uuid::Uuid::new_v4()),
            expires: std::time::Instant::now() + GRANT_LIFETIME,
            pages: Some(DirectoryPages::new(root)),
        }
    }

    fn revoke(&mut self) {
        self.expected = None;
        self.pages = None;
    }

    fn next(&mut self, grant: uuid::Uuid, cursor: uuid::Uuid) -> io::Result<FolderReadPage> {
        if std::time::Instant::now() >= self.expires {
            self.revoke();
        }
        if grant != self.id || self.expected != Some(cursor) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.expected = None;
        let pages = self
            .pages
            .as_mut()
            .ok_or(io::ErrorKind::PermissionDenied)?;
        match pages.next() {
            Ok(Some(entries)) => {
                self.expected = Some(uuid::Uuid::new_v4());
                Ok(FolderReadPage {
                    entries: entries
                        .into_iter()
                        .map(|entry| FolderReadEntry {
                            name: entry.name,
                            size_bytes: entry.size_bytes,
                        })
                        .collect(),
                    next: self.expected,
                })
            }
            Ok(None) => {
                self.revoke();
                Ok(FolderReadPage {
                    entries: Vec::new(),
                    next: None,
                })
            }
            Err(error) => {
                self.revoke();
                Err(error)
            }
        }
    }
}

fn inspect_local_directory(directory: &PinnedDirectory) -> io::Result<()> {
    let mut attributes = FILE_ATTRIBUTE_TAG_INFO::default();
    let success = unsafe {
        GetFileInformationByHandleEx(
            directory.0.as_raw_handle().cast(),
            FileAttributeTagInfo,
            std::ptr::from_mut(&mut attributes).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    if attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || attributes.FileAttributes & NON_LOCAL_ATTRIBUTES != 0
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

fn read_metadata_page(
    directory: &PinnedDirectory,
    restart: bool,
) -> io::Result<Option<Vec<DirectoryEntryMetadata>>> {
    inspect_local_directory(directory)?;
    let mut page = Buffer([0; PAGE_BYTES]);
    let class = if restart {
        FileIdExtdDirectoryRestartInfo
    } else {
        FileIdExtdDirectoryInfo
    };
    // Valid live handle plus non-aliasing zeroed ABI-aligned output buffer.
    // Parse only a successfully completed record chain, never cast the bytes.
    let success = unsafe {
        GetFileInformationByHandleEx(
            directory.0.as_raw_handle().cast(),
            class,
            page.0.as_mut_ptr().cast(),
            PAGE_BYTES as u32,
        )
    };
    if success == 0 {
        let failure = io::Error::last_os_error();
        return if failure.raw_os_error().is_some_and(|code| {
            code == ERROR_NO_MORE_FILES as i32 || code == ERROR_HANDLE_EOF as i32
        }) {
            Ok(None)
        } else {
            Err(failure)
        };
    }
    inspect_local_directory(directory)?;
    parse_page(&page.0).map(Some)
}

#[test]
fn pinned_metadata_paging_reads_only_the_chosen_directory_level_and_releases_it() {
    use std::{collections::BTreeSet, fs};

    // The default ".tmp" prefix is deliberately not a valid pinned path leaf.
    let temp = tempfile::Builder::new()
        .prefix("aerift-folder-page-")
        .tempdir()
        .unwrap();
    let chosen = temp.path().join("chosen");
    let sibling = temp.path().join("sibling");
    fs::create_dir(&chosen).unwrap();
    fs::create_dir(&sibling).unwrap();
    fs::write(sibling.join("outside.txt"), b"synthetic sentinel").unwrap();
    fs::create_dir(chosen.join("nested")).unwrap();
    fs::write(
        chosen.join("nested").join("inside.txt"),
        b"synthetic sentinel",
    )
    .unwrap();
    // Force several 16 KiB native pages without using a live folder.
    let leaf = "metadata-fixture-".repeat(7);
    for n in 0..300 {
        fs::write(chosen.join(format!("{leaf}{n:04}.txt")), b"xyz").unwrap();
    }

    let mut list = DirectoryPages::new(PinnedDirectory::from_native_selection(&chosen).unwrap());
    let mut output = BTreeSet::new();
    let mut pages = 0;
    while let Some(entries) = list.next().unwrap() {
        pages += 1;
        for entry in entries {
            assert_eq!(entry.size_bytes, (entry.name != "nested").then_some(3));
            assert_ne!(entry.file_id, [0; 16]);
            assert!(output.insert(entry.name));
        }
    }
    assert!(pages > 1);
    assert!(output.contains("nested"));
    assert_eq!(output.len(), 301);
    assert!(!output.contains("inside.txt"));
    assert!(!output.contains("outside.txt"));
    assert!(list.next().unwrap().is_none());
    fs::rename(&chosen, temp.path().join("renamed-after-eof")).unwrap();
}

#[test]
fn folder_grants_do_not_accept_foreign_or_replayed_cursors_and_revoke_releases_the_root() {
    use std::{fs, time::Duration};

    let temp = tempfile::Builder::new()
        .prefix("aerift-folder-grant-")
        .tempdir()
        .unwrap();
    let chosen = temp.path().join("chosen");
    let outside = temp.path().join("outside");
    fs::create_dir(&chosen).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(chosen.join("listed.txt"), b"chosen").unwrap();
    fs::write(outside.join("ungranted.txt"), b"outside").unwrap();

    let mut a = FolderReadGrant::new(PinnedDirectory::from_native_selection(&chosen).unwrap());
    let mut b = FolderReadGrant::new(PinnedDirectory::from_native_selection(&outside).unwrap());
    let first = a.expected.unwrap();
    let foreign = b.expected.unwrap();
    let ap = a.id;
    let bp = b.id;

    assert_eq!(
        a.next(bp, first).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        a.next(ap, foreign).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );

    let rows = a.next(ap, first).unwrap();
    assert_eq!(rows.entries.len(), 1);
    assert_eq!(rows.entries[0].name, "listed.txt");
    assert_eq!(rows.entries[0].size_bytes, Some(6));
    assert_eq!(
        a.next(ap, first).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    let next = rows.next.unwrap();
    a.revoke();
    assert_eq!(
        a.next(ap, next).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    fs::rename(&chosen, temp.path().join("released")).unwrap();

    b.expires = std::time::Instant::now() - Duration::from_millis(1);
    assert_eq!(
        b.next(bp, foreign).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    fs::rename(&outside, temp.path().join("expired")).unwrap();
}
