pub(super) fn is_drive_path(path: &str, allow_root: bool) -> bool {
    let bytes = path.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\" {
        return false;
    }
    let relative = &path[3..];
    if relative.is_empty() {
        return allow_root;
    }
    relative.split('\\').all(|component| {
        if component.is_empty()
            || component.ends_with([' ', '.'])
            || component.chars().any(|ch| {
                ch.is_control() || matches!(ch, '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            })
        {
            return false;
        }
        let name = component
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end_matches(' ');
        let name = name.to_ascii_uppercase();
        let serial_or_printer = name
            .strip_prefix("COM")
            .or_else(|| name.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(
                    suffix,
                    "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            });
        !serial_or_printer
            && !matches!(
                name.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            )
    })
}

pub(super) fn safe_attributes(attrs: u32) -> bool {
    // INVALID_FILE_ATTRIBUTES, REPARSE_POINT, OFFLINE, RECALL_ON_OPEN, RECALL_ON_DATA_ACCESS.
    attrs != u32::MAX && attrs & (0x400 | 0x1000 | 0x40000 | 0x400000) == 0
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_native_namespace_network_and_path_aliases() {
        for path in [
            r"\\server\share\file.txt",
            r"\\?\C:\file.txt",
            r"C:selection.txt",
            r"C:\dir\..\file.txt",
            r"C:\dir\file.txt:private",
            r"C:\dir.\file.txt",
            r"C:\dir\NUL.txt",
            r"C:\dir\com¹.ext",
            r"C:\",
        ] {
            assert!(!is_drive_path(path, false), "accepted {path:?}");
        }
    }

    #[test]
    fn allows_files_folders_and_receive_root_only_as_destination() {
        assert!(is_drive_path(r"D:\Pictures\Café.jpg", false));
        assert!(is_drive_path(r"d:\Friends\subfolder", false));
        assert!(is_drive_path(r"C:\", true));
        assert!(!is_drive_path(r"C:\folder\\file.txt", true));
    }

    #[test]
    fn placeholder_and_reparse_attributes_fail_closed() {
        for attrs in [u32::MAX, 0x400, 0x1000, 0x40000, 0x400000] {
            assert!(!safe_attributes(attrs));
        }
        assert!(safe_attributes(0x20));
        assert!(safe_attributes(0x10));
    }
}
