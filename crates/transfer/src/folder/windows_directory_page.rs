//! Test-only Windows prototype: metadata from an already pinned directory.
//! No root selection, path arguments, child opening, content or IPC.

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
