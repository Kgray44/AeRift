# Windows chosen-folder metadata prototype: qualification

**Scope:** Test-only Windows listing from an already pinned directory. No app
picker/IPC, recursive traversal, content, writes, or user-device tests. Run on
disposable Windows x64 MSVC with an ordinary ASCII-path temporary directory on
fixed NTFS; record the exact commit, runner OS, and Rust version (1.89+).

```powershell
rustc -vV
cargo fmt --all --check
cargo test --locked -p aerift-transfer --lib folder::windows_handles::directory_page -- --list
cargo test --locked -p aerift-transfer --lib folder::windows_handles::directory_page -- --test-threads=1
cargo test --locked -p aerift-transfer --lib folder::windows_handles -- --test-threads=1
```

- Require five named prototype tests (four decoding tests, one real NTFS
  multi-page test), rather than accepting a filter that matched zero tests.
  The real test must list all 301 direct items exactly once across more than
  one page, omit nested and sibling sentinels, reach EOF, and release the
  pinned handles so the selected directory can be renamed. Existing Windows
  export/receipt tests must stay green. Do not weaken the fixture to hide OS
  errors, fall back to path enumeration, or touch an installed app.
- The pinned `windows-sys 0.61.2` exports the calls/classes/list structure under
  existing `Win32_Storage_FileSystem` plus `Win32_Foundation` for the native
  handle/BOOL and EOF constants; no dependency, manifest, or lock change.
  The Windows compile checks `FILE_ID_EXTD_DIR_INFO` offsets 0, 40, 56, 60,
  72, 88; confirm ABI-supported first/restart and continuation behavior and
  actual EOF from `GetFileInformationByHandleEx` on NTFS. Buffer is 8-aligned,
  zeroed, bounded to 16 KiB; decode does not cast data to the struct. Stock
  rustfmt may reflow nested imports and long test records; format only the
  candidate changes on the disposable checkout and re-run checks.
- This prototype assumes a stable synthetic directory while paging. The Windows
  cursor is not a snapshot under changes. Empty filtered pages need not be
  EOF; unexpected Win32 errors or invalid records stop and release handles.
  Non-NTFS/provider roots, Unicode root navigation, final entry containment,
  root/entry capability IPC, and native picker behavior remain unqualified.

References: [Microsoft Win32 enumeration](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex),
[pinned Rust binding layout](https://docs.rs/windows-sys/latest/windows_sys/Win32/Storage/FileSystem/struct.FILE_ID_EXTD_DIR_INFO.html).
