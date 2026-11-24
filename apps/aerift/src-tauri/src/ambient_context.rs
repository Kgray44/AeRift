//! Read-only Windows Explorer context snapshot. Call only for an explicit pickup,
//! on a blocking worker; never from a camera frame loop. No Shell data escapes
//! on partial failure, no alternate view/window is searched for its selections.
use std::{
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr,
};

use windows::{
    core::{Interface, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND},
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        Storage::FileSystem::{GetDriveTypeW, GetFileAttributesW, FILE_ATTRIBUTE_DIRECTORY},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IDispatch,
                IServiceProvider, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
                COINIT_DISABLE_OLE1DDE,
            },
            StationsAndDesktops::{
                CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
                DESKTOP_READOBJECTS, UOI_NAME,
            },
            SystemInformation::GetWindowsDirectoryW,
            Threading::{
                OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            Variant::VARIANT,
        },
        UI::{
            Shell::{
                IFolderView, IFolderView2, IPersistFolder2, IShellBrowser, IShellItem, IShellView,
                IShellWindows, IWebBrowserApp, SHCreateItemFromIDList, SID_STopLevelBrowser,
                ShellWindows, SIGDN_FILESYSPATH, SVGIO_SELECTION, SWC_DESKTOP, SWFO_NEEDDISPATCH,
            },
            WindowsAndMessaging::{
                GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetShellWindow,
                GetWindowThreadProcessId, IsChild, IsWindowVisible, GUITHREADINFO,
            },
        },
    },
};

#[path = "ambient_context/path_policy.rs"]
mod path_policy;

const MAX_SELECTED: u32 = 256;
const MAX_SHELL_WINDOWS: i32 = 256;

pub(crate) struct ExplorerContext {
    pub(crate) source_executable: String,
    pub(crate) explicit_selection: Vec<PathBuf>,
    pub(crate) target_folder: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContextError {
    Unsupported,
    SelectionChanged,
    UnsafeSelection,
    SelectionTooLarge,
    Unavailable,
}

impl From<windows::core::Error> for ContextError {
    fn from(_: windows::core::Error) -> Self {
        Self::Unavailable
    }
}

struct ComApartment;
impl ComApartment {
    fn sta() -> Result<Self, ContextError> {
        // S_OK and S_FALSE both require a matching CoUninitialize. A caller on
        // an MTA gets RPC_E_CHANGED_MODE and must use its dedicated STA worker.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()? };
        Ok(Self)
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

// Exposed to lifecycle host logic as a privacy guard as well as checked just
// before and after extraction. No desktop hook, no focus action.
pub(crate) fn interactive_session() -> bool {
    unsafe {
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let mut name = [0u16; 64];
        let mut required = 0u32;
        let result = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            (name.len() * size_of::<u16>()) as u32,
            Some(&mut required),
        );
        let _ = CloseDesktop(desktop);
        let len = (required as usize / size_of::<u16>()).saturating_sub(1);
        result.is_ok()
            && name
                .get(..len)
                .is_some_and(|value| value.iter().copied().eq("Default".encode_utf16()))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Foreground {
    window: HWND,
    thread: u32,
    process: u32,
    focused: HWND,
}
impl Foreground {
    fn current() -> Result<Self, ContextError> {
        if !interactive_session() {
            return Err(ContextError::Unsupported);
        }
        unsafe {
            let window = GetForegroundWindow();
            if window.0.is_null() {
                return Err(ContextError::Unavailable);
            }
            let mut process = 0;
            let thread = GetWindowThreadProcessId(window, Some(&mut process));
            if thread == 0 || process == 0 {
                return Err(ContextError::Unavailable);
            }
            let mut info = GUITHREADINFO {
                cbSize: size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            GetGUIThreadInfo(thread, &mut info)?;
            // Refuse move/size, System/App menus, and caret use rather than
            // inheriting stale selection from an input control or modal surface.
            if info.hwndActive != window
                || info.hwndFocus.0.is_null()
                || info.flags.0 & 0x1f != 0
                || !info.hwndCaret.0.is_null()
            {
                return Err(ContextError::Unsupported);
            }
            Ok(Self {
                window,
                thread,
                process,
                focused: info.hwndFocus,
            })
        }
    }

    fn includes_view(self, window: HWND) -> bool {
        !window.0.is_null()
            && unsafe {
                IsWindowVisible(window).as_bool()
                    && (self.focused == window || IsChild(window, self.focused).as_bool())
            }
    }
}

fn window_class(hwnd: HWND) -> Result<String, ContextError> {
    let mut class = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut class) };
    if len <= 0 || len as usize >= class.len() - 1 {
        return Err(ContextError::Unavailable);
    }
    String::from_utf16(&class[..len as usize]).map_err(|_| ContextError::Unavailable)
}

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn process_image(pid: u32, reject_elevated: bool) -> Result<String, ContextError> {
    let process =
        OwnedHandle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)? });
    if reject_elevated {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token)? };
        let token = OwnedHandle(token);
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        unsafe {
            GetTokenInformation(
                token.0,
                TokenElevation,
                Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            )?
        };
        if returned as usize != size_of::<TOKEN_ELEVATION>() || elevation.TokenIsElevated != 0 {
            return Err(ContextError::Unsupported);
        }
    }
    let mut value = vec![0u16; 32_768];
    let mut len = value.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(value.as_mut_ptr()),
            &mut len,
        )?
    };
    String::from_utf16(value.get(..len as usize).ok_or(ContextError::Unavailable)?)
        .map_err(|_| ContextError::Unavailable)
}

/// Filename only, for locally evaluated exclusions; no argv, window titles,
/// documents, selection, or full executable path leaves this adapter.
pub(crate) fn foreground_executable() -> Option<String> {
    if !interactive_session() {
        return None;
    }
    let window = unsafe { GetForegroundWindow() };
    if window.0.is_null() {
        return None;
    }
    let mut process = 0;
    let thread = unsafe { GetWindowThreadProcessId(window, Some(&mut process)) };
    if thread == 0 || process == 0 {
        return None;
    }
    let image = process_image(process, false).ok()?;
    let mut latest_process = 0;
    if unsafe { GetForegroundWindow() } != window
        || unsafe { GetWindowThreadProcessId(window, Some(&mut latest_process)) } != thread
        || latest_process != process
    {
        return None;
    }
    Path::new(&image)
        .file_name()?
        .to_str()
        .map(str::to_ascii_lowercase)
}

fn explorer_process(process: u32) -> Result<(), ContextError> {
    let mut root = [0u16; 1024];
    let root_len = unsafe { GetWindowsDirectoryW(Some(&mut root)) } as usize;
    if root_len == 0 || root_len >= root.len() {
        return Err(ContextError::Unavailable);
    }
    let root = String::from_utf16(&root[..root_len]).map_err(|_| ContextError::Unavailable)?;
    let expected = format!(r"{}\explorer.exe", root.trim_end_matches('\\'));
    let actual = process_image(process, true)?;
    if actual.eq_ignore_ascii_case(&expected) {
        Ok(())
    } else {
        Err(ContextError::Unsupported)
    }
}

fn view_for(dispatch: &IDispatch, foreground: Foreground) -> Result<IShellView, ContextError> {
    let provider: IServiceProvider = dispatch.cast()?;
    let browser: IShellBrowser = unsafe { provider.QueryService(&SID_STopLevelBrowser)? };
    let view = unsafe { browser.QueryActiveShellView()? };
    let view_window = unsafe { view.GetWindow()? };
    if foreground.includes_view(view_window) {
        Ok(view)
    } else {
        Err(ContextError::Unsupported)
    }
}

fn active_folder_view(foreground: Foreground, class: &str) -> Result<IShellView, ContextError> {
    unsafe {
        let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)?;
        if matches!(class, "Progman" | "WorkerW") {
            let mut own_shell = 0;
            let window = GetShellWindow();
            GetWindowThreadProcessId(window, Some(&mut own_shell));
            if own_shell == 0 || own_shell != foreground.process {
                return Err(ContextError::Unsupported);
            }
            let location = VARIANT::default();
            let mut ignored = 0;
            let shell = windows.FindWindowSW(
                &location,
                ptr::null(),
                SWC_DESKTOP,
                &mut ignored,
                SWFO_NEEDDISPATCH,
            )?;
            return view_for(&shell, foreground);
        }
        let count = windows.Count()?;
        if !(0..=MAX_SHELL_WINDOWS).contains(&count) {
            return Err(ContextError::Unavailable);
        }
        let mut matching = None;
        for index in 0..count {
            let Ok(candidate) = windows.Item(&VARIANT::from(index)) else {
                continue;
            };
            let Ok(application) = candidate.cast::<IWebBrowserApp>() else {
                continue;
            };
            if application.HWND().ok().map(|value| value.0 as usize)
                != Some(foreground.window.0 as usize)
            {
                continue;
            }
            let Ok(view) = view_for(&candidate, foreground) else {
                continue;
            };
            // Some builds can report multiple tab registrations. Keep only
            // consistent registrations for the very same focused view window.
            if let Some(previous) = &matching {
                let previous: &IShellView = previous;
                if previous.GetWindow()? != view.GetWindow()? {
                    return Err(ContextError::SelectionChanged);
                }
            } else {
                matching = Some(view);
            }
        }
        matching.ok_or(ContextError::Unsupported)
    }
}

fn safe_path(item: &IShellItem, allow_root: bool) -> Result<(PathBuf, u32), ContextError> {
    let native = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }
        .map_err(|_| ContextError::UnsafeSelection)?;
    if native.0.is_null() {
        return Err(ContextError::UnsafeSelection);
    }
    let result = unsafe { native.to_string() };
    unsafe { CoTaskMemFree(Some(native.0.cast())) };
    let value = result.map_err(|_| ContextError::UnsafeSelection)?;
    if !path_policy::is_drive_path(&value, allow_root) {
        return Err(ContextError::UnsafeSelection);
    }
    let root = value[..3].encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    if unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } != 3 {
        // DRIVE_FIXED
        return Err(ContextError::UnsafeSelection);
    }
    let path = PathBuf::from(value);
    // Inspect ancestors root-first, before touching any child which might
    // otherwise cause traversal through a junction or cloud placeholder.
    let ancestors = path
        .ancestors()
        .skip(1)
        .take_while(|parent| !parent.as_os_str().is_empty())
        .collect::<Vec<_>>();
    for ancestor in ancestors.into_iter().rev() {
        let attributes = path_attributes(ancestor)?;
        if attributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
            return Err(ContextError::UnsafeSelection);
        }
    }
    let attributes = path_attributes(&path)?;
    Ok((path, attributes))
}

fn path_attributes(path: &Path) -> Result<u32, ContextError> {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let attributes = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
    path_policy::safe_attributes(attributes)
        .then_some(attributes)
        .ok_or(ContextError::UnsafeSelection)
}

fn active_filesystem_folder(folder: &IFolderView) -> Option<PathBuf> {
    // Some Explorer views expose only IShellFolder/IPersistFolder2 here.
    let item = unsafe { folder.GetFolder::<IShellItem>() }
        .ok()
        .or_else(|| {
            let persist = unsafe { folder.GetFolder::<IPersistFolder2>() }.ok()?;
            let pidl = unsafe { persist.GetCurFolder() }.ok()?;
            if pidl.is_null() {
                return None;
            }
            let item = unsafe { SHCreateItemFromIDList::<IShellItem>(pidl) };
            unsafe { CoTaskMemFree(Some(pidl.cast())) };
            item.ok()
        })?;
    let (path, flags) = safe_path(&item, true).ok()?;
    (flags & FILE_ATTRIBUTE_DIRECTORY.0 != 0).then_some(path)
}

/// Opaque, Send-safe window identity, taken synchronously at requested pickup.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct CaptureAnchor {
    window: usize,
    thread: u32,
    process: u32,
    focus: usize,
}

pub(crate) fn capture_anchor() -> Result<CaptureAnchor, ContextError> {
    let fg = Foreground::current()?;
    Ok(CaptureAnchor {
        window: fg.window.0 as usize,
        thread: fg.thread,
        process: fg.process,
        focus: fg.focused.0 as usize,
    })
}

pub(crate) mod receive_destination;

// The receiving adapter resolves an exact native folder without inspecting
// selected file contents or turning a selection into writable authority.
fn active_receive_folder(anchor: CaptureAnchor) -> Result<PathBuf, ContextError> {
    let foreground = Foreground::current()?;
    if capture_anchor()? != anchor {
        return Err(ContextError::SelectionChanged);
    }
    let class = window_class(foreground.window)?;
    if !matches!(class.as_str(), "CabinetWClass" | "ExploreWClass") {
        return Err(ContextError::Unsupported);
    }
    explorer_process(foreground.process)?;
    let _com = ComApartment::sta()?;
    let view = active_folder_view(foreground, &class)?;
    let folder: IFolderView = view.cast()?;
    let target = active_filesystem_folder(&folder).ok_or(ContextError::UnsafeSelection)?;
    if Foreground::current()? != foreground || capture_anchor()? != anchor {
        return Err(ContextError::SelectionChanged);
    }
    Ok(target)
}

pub(crate) fn capture(anchor: CaptureAnchor) -> Result<ExplorerContext, ContextError> {
    let foreground = Foreground::current()?;
    if capture_anchor()? != anchor {
        return Err(ContextError::SelectionChanged);
    }
    let class = window_class(foreground.window)?;
    if !matches!(
        class.as_str(),
        "CabinetWClass" | "ExploreWClass" | "Progman" | "WorkerW"
    ) {
        return Err(ContextError::Unsupported);
    }
    explorer_process(foreground.process)?;
    let _com = ComApartment::sta()?;
    let view = active_folder_view(foreground, &class)?;
    let folder: IFolderView = view.cast()?;
    let selected = unsafe { folder.ItemCount(SVGIO_SELECTION)? };
    if selected < 0 {
        return Err(ContextError::Unavailable);
    }
    if selected as u32 > MAX_SELECTED {
        return Err(ContextError::SelectionTooLarge);
    }
    let mut explicit_selection = Vec::with_capacity(selected as usize);
    if selected > 0 {
        let view_items: IFolderView2 = view.cast()?;
        // false: an empty selection is empty, never promote the folder to a selection.
        let items = unsafe { view_items.GetSelection(false)? };
        if unsafe { items.GetCount()? } != selected as u32 {
            return Err(ContextError::SelectionChanged);
        }
        for index in 0..selected as u32 {
            explicit_selection.push(safe_path(&unsafe { items.GetItemAt(index)? }, false)?.0);
        }
    }
    // A provider may change selections without changing the item count. The
    // second snapshot must describe the same ordered files before freezing.
    if selected > 0 {
        let view_items: IFolderView2 = view.cast()?;
        let items = unsafe { view_items.GetSelection(false)? };
        if unsafe { items.GetCount()? } != selected as u32 {
            return Err(ContextError::SelectionChanged);
        }
        for (index, prior) in explicit_selection.iter().enumerate() {
            if safe_path(&unsafe { items.GetItemAt(index as u32)? }, false)?.0 != *prior {
                return Err(ContextError::SelectionChanged);
            }
        }
    }
    let target_folder = active_filesystem_folder(&folder);
    if Foreground::current()? != foreground
        || capture_anchor()? != anchor
        || unsafe { folder.ItemCount(SVGIO_SELECTION)? } != selected
    {
        return Err(ContextError::SelectionChanged);
    }
    Ok(ExplorerContext {
        source_executable: "explorer.exe".to_owned(),
        explicit_selection,
        target_folder,
    })
}
