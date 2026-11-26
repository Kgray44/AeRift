//! Decoder for one bounded native FILE_ID_EXTD_DIR_INFO page.
//! No byte record is an authority to open a path.

use std::io;

pub(crate) const NEXT_OFFSET: usize = 0;
pub(crate) const SIZE_OFFSET: usize = 40;
pub(crate) const ATTRIBUTES_OFFSET: usize = 56;
pub(crate) const NAME_LENGTH_OFFSET: usize = 60;
pub(crate) const ID_OFFSET: usize = 72;
pub(crate) const NAME_OFFSET: usize = 88;
pub(crate) const PAGE_BYTES: usize = 16 * 1024;
const MAX_NAME_BYTES: usize = 255 * 2;
const DIRECTORY: u32 = 0x10;
const HIDDEN: u32 = 0x2;
const SYSTEM: u32 = 0x4;
const DEVICE: u32 = 0x40;
const REPARSE: u32 = 0x400;
const OFFLINE: u32 = 0x1000;
const VIRTUAL: u32 = 0x10000;
const RECALL_ON_OPEN: u32 = 0x40000;
const RECALL_ON_DATA_ACCESS: u32 = 0x00400000;

pub(crate) const NON_LOCAL_ATTRIBUTES: u32 =
    REPARSE | OFFLINE | VIRTUAL | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS;
const EXCLUDED_ATTRIBUTES: u32 = NON_LOCAL_ATTRIBUTES | HIDDEN | SYSTEM | DEVICE;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DirectoryEntryMetadata {
    pub(crate) name: String,
    // No size claim for a folder. A file's size is not a permission or receipt.
    pub(crate) size_bytes: Option<u64>,
    // Native-only identity hint; never publish file IDs to JavaScript.
    pub(crate) file_id: [u8; 16],
}

fn invalid() -> io::Error {
    io::Error::from(io::ErrorKind::InvalidData)
}

fn field<const N: usize>(bytes: &[u8], offset: usize) -> io::Result<[u8; N]> {
    bytes
        .get(offset..offset + N)
        .and_then(|part| part.try_into().ok())
        .ok_or_else(invalid)
}

fn read_u32(bytes: &[u8], offset: usize) -> io::Result<u32> {
    field(bytes, offset).map(u32::from_le_bytes)
}

fn usable_name(name: &str) -> bool {
    name != "."
        && name != ".."
        && !name.ends_with([' ', '.'])
        && !name
            .chars()
            .any(|ch| matches!(ch, '/' | '\\' | ':') || ch.is_control())
}

pub(crate) fn parse_page(bytes: &[u8]) -> io::Result<Vec<DirectoryEntryMetadata>> {
    if bytes.len() > PAGE_BYTES {
        return Err(invalid());
    }
    let mut remaining = bytes;
    let mut out = Vec::new();
    loop {
        let next = read_u32(remaining, NEXT_OFFSET)? as usize;
        let name_len = read_u32(remaining, NAME_LENGTH_OFFSET)? as usize;
        if name_len == 0 || name_len > MAX_NAME_BYTES || !name_len.is_multiple_of(2) {
            return Err(invalid());
        }
        let end_name = NAME_OFFSET + name_len;
        if next != 0 && (next < end_name || next >= remaining.len() || !next.is_multiple_of(8)) {
            return Err(invalid());
        }
        let encoded = remaining.get(NAME_OFFSET..end_name).ok_or_else(invalid)?;
        let attrs = read_u32(remaining, ATTRIBUTES_OFFSET)?;
        let file_id = field::<16>(remaining, ID_OFFSET)?;
        if attrs & EXCLUDED_ATTRIBUTES == 0 && file_id != [0; 16] {
            let utf16: Vec<_> = encoded
                .chunks_exact(2)
                .map(|unit| u16::from_le_bytes([unit[0], unit[1]]))
                .collect();
            if let Ok(name) = String::from_utf16(&utf16) {
                if usable_name(&name) {
                    let size_bytes = if attrs & DIRECTORY == 0 {
                        let size = i64::from_le_bytes(field(remaining, SIZE_OFFSET)?);
                        Some(u64::try_from(size).map_err(|_| invalid())?)
                    } else {
                        None
                    };
                    out.push(DirectoryEntryMetadata {
                        name,
                        size_bytes,
                        file_id,
                    });
                }
            }
        }
        if next == 0 {
            return Ok(out);
        }
        remaining = &remaining[next..];
    }
}

// Portable unit tests can be run with rustc --test this file. The Windows
// caller separately binds these offsets to the windows-sys C layout.
#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, attributes: u32, id: u8, size_bytes: i64) -> Vec<u8> {
        let name: Vec<_> = name.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut bytes = vec![0; (NAME_OFFSET + name.len()).next_multiple_of(8)];
        bytes[SIZE_OFFSET..SIZE_OFFSET + 8].copy_from_slice(&size_bytes.to_le_bytes());
        bytes[ATTRIBUTES_OFFSET..ATTRIBUTES_OFFSET + 4].copy_from_slice(&attributes.to_le_bytes());
        bytes[NAME_LENGTH_OFFSET..NAME_LENGTH_OFFSET + 4]
            .copy_from_slice(&(name.len() as u32).to_le_bytes());
        bytes[ID_OFFSET..ID_OFFSET + 16].fill(id);
        bytes[NAME_OFFSET..NAME_OFFSET + name.len()].copy_from_slice(&name);
        bytes
    }

    fn chain(rows: Vec<Vec<u8>>) -> Vec<u8> {
        let count = rows.len();
        let mut page = Vec::new();
        for (index, mut row) in rows.into_iter().enumerate() {
            if index + 1 != count {
                let next = row.len() as u32;
                row[..4].copy_from_slice(&next.to_le_bytes());
            }
            page.extend(row);
        }
        page
    }

    #[test]
    fn decodes_unicode_regular_metadata_and_directory_without_paths() {
        let page = chain(vec![
            row(".", DIRECTORY, 1, 0),
            row("Photos", DIRECTORY, 2, 0),
            row("café 2.jpg", 0x80, 3, 4096),
        ]);
        assert_eq!(
            parse_page(&page).unwrap(),
            [
                DirectoryEntryMetadata {
                    name: "Photos".into(),
                    size_bytes: None,
                    file_id: [2; 16]
                },
                DirectoryEntryMetadata {
                    name: "café 2.jpg".into(),
                    size_bytes: Some(4096),
                    file_id: [3; 16]
                },
            ]
        );
    }

    #[test]
    fn excludes_provider_placeholder_reparse_and_non_user_entries() {
        let page = chain(vec![
            row("link", DIRECTORY | REPARSE, 1, 0),
            row("needs-provider", RECALL_ON_DATA_ACCESS, 2, 990),
            row("offline", OFFLINE, 3, 222),
            row("system", SYSTEM, 4, 333),
            row("hidden", HIDDEN, 5, 444),
            row("local.txt", 0x80, 6, 5),
        ]);
        assert_eq!(parse_page(&page).unwrap().len(), 1);
        assert_eq!(parse_page(&page).unwrap()[0].name, "local.txt");
    }

    #[test]
    fn detects_incomplete_pages_and_unusable_lengths_without_partial_output() {
        assert!(parse_page(&row("visible.txt", 0x80, 1, 5)[..NAME_OFFSET + 1]).is_err());
        let mut page = chain(vec![
            row("first.txt", 0x80, 1, 2),
            row("second.txt", 0x80, 2, 3),
        ]);
        let final_record = read_u32(&page, 0).unwrap() as usize;
        page[final_record + NAME_LENGTH_OFFSET] |= 1;
        assert!(parse_page(&page).is_err());
        let mut bad_size = row("valid-name.txt", 0x80, 1, -1);
        assert!(parse_page(&bad_size).is_err());
        bad_size[..4].copy_from_slice(&8_u32.to_le_bytes());
        assert!(parse_page(&bad_size).is_err());
    }

    #[test]
    fn never_presents_unusable_names_or_zero_identity() {
        let page = chain(vec![
            row("directory\\child", 0x80, 1, 2),
            row("stream:name", 0x80, 2, 2),
            row("without-id", 0x80, 0, 2),
            row("keep.txt", 0x80, 3, 2),
        ]);
        let entries = parse_page(&page).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "keep.txt");
    }
}
