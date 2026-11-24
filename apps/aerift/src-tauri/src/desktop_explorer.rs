use std::{ffi::OsString, os::windows::ffi::OsStrExt, path::Path, ptr::null_mut};

use aerift_transfer::{ErrorCode, TransferError};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
    System::Registry::{
        RegDeleteKeyW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    },
    UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST},
};

use crate::{desktop::show_main, selection::SelectionRegistry};

const VERB: &str = r"Software\Classes\*\shell\AeRift.StageInRift";
const COMMAND: &str = r"Software\Classes\*\shell\AeRift.StageInRift\command";
const LABEL: &str = "Stage in AeRift";
const STAGE: &str = "--stage-file";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn command_value() -> Result<Vec<u16>, TransferError> {
    let executable = std::env::current_exe().map_err(|_| ErrorCode::InternalError)?;
    let mut value = vec![u16::from(b'"')];
    value.extend(executable.as_os_str().encode_wide());
    value.extend(format!(r#"" {STAGE} "%1""#).encode_utf16());
    value.push(0);
    Ok(value)
}

fn registered_command() -> Result<Option<Vec<u16>>, TransferError> {
    let key = wide(COMMAND);
    // A command line has a 32,767 UTF-16 code-unit Windows limit, including the terminator.
    let mut value = vec![0u16; 32_767];
    let mut bytes = (value.len() * size_of::<u16>()) as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            std::ptr::null(),
            RRF_RT_REG_SZ,
            null_mut(),
            value.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    match result {
        ERROR_SUCCESS => {
            value.truncate(bytes as usize / size_of::<u16>());
            Ok(Some(value))
        }
        ERROR_FILE_NOT_FOUND => Ok(None),
        _ => Err(ErrorCode::StorageFailed.into()),
    }
}

fn set_value(key: &str, name: Option<&str>, value: &[u16]) -> Result<(), TransferError> {
    let key = wide(key);
    let name = name.map(wide);
    let bytes =
        u32::try_from(value.len() * size_of::<u16>()).map_err(|_| ErrorCode::InvalidRequest)?;
    let result = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ref().map_or(std::ptr::null(), |name| name.as_ptr()),
            REG_SZ,
            value.as_ptr().cast(),
            bytes,
        )
    };
    if result == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(ErrorCode::StorageFailed.into())
    }
}

#[tauri::command]
pub(crate) fn desktop_explorer_enabled() -> Result<bool, TransferError> {
    Ok(registered_command()?
        .is_some_and(|value| command_value().is_ok_and(|expected| value == expected)))
}

#[tauri::command]
pub(crate) fn set_desktop_explorer(enabled: bool) -> Result<bool, TransferError> {
    let expected = command_value()?;
    let previous = registered_command()?;
    if previous
        .as_ref()
        .is_some_and(|existing| existing != &expected)
    {
        return Err(ErrorCode::Conflict.into());
    }
    if enabled {
        set_value(VERB, Some("MUIVerb"), &wide(LABEL))?;
        set_value(VERB, Some("MultiSelectModel"), &wide("Single"))?;
        set_value(COMMAND, None, &expected)?;
    } else if previous.is_some() {
        for key in [COMMAND, VERB] {
            let result = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, wide(key).as_ptr()) };
            if !matches!(result, ERROR_SUCCESS | ERROR_FILE_NOT_FOUND) {
                return Err(ErrorCode::StorageFailed.into());
            }
        }
    }
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    desktop_explorer_enabled()
}

fn requested_path(args: &[OsString]) -> Option<&Path> {
    let [flag, path] = args else {
        return None;
    };
    if flag != STAGE || path.is_empty() {
        return None;
    }
    Some(Path::new(path))
}

pub(crate) fn stage_launch_file(app: &AppHandle, args: &[OsString], cwd: Option<&Path>) -> bool {
    if !app
        .try_state::<crate::runtime::AppRuntime>()
        .is_some_and(|runtime| runtime.nearby_enabled())
    {
        return false;
    }
    let Some(path) = requested_path(args) else {
        return false;
    };
    let path = if path.is_absolute() {
        path.to_owned()
    } else if let Some(cwd) = cwd {
        cwd.join(path)
    } else {
        return false;
    };
    let Some(registry) = app.try_state::<SelectionRegistry>() else {
        return false;
    };
    let Ok(revision) = registry.begin() else {
        return false;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app
            .state::<SelectionRegistry>()
            .select(revision, &path, true);
    });
    true
}

pub(crate) fn on_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    let args: Vec<_> = args.into_iter().skip(1).map(OsString::from).collect();
    let staged = stage_launch_file(app, &args, Some(Path::new(&cwd)));
    show_main(app, staged.then_some("rift"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_single_file_launch_is_staged() {
        let args = |values: &[&str]| values.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            requested_path(&args(&[STAGE, "Quarterly notes.txt"])),
            Some(Path::new("Quarterly notes.txt"))
        );
        assert!(requested_path(&args(&["Quarterly notes.txt"])).is_none());
        assert!(requested_path(&args(&[STAGE, "one.txt", "two.txt"])).is_none());
        assert!(requested_path(&args(&[STAGE, ""])).is_none());
    }
}
