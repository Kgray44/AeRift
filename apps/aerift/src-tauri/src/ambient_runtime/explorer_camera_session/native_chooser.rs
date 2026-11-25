//! Native camera metadata + consent UI. No camera source, frames, or device
//! access prompt can be opened by this producer.
use aerift_transfer::ambient_camera::{CameraIssue, RgbLandmarker};
use std::{ffi::OsString, os::windows::ffi::OsStringExt, ptr::null_mut};
use windows::{
    Security::Authorization::AppCapabilityAccess::{AppCapability, AppCapabilityAccessStatus},
    Win32::{
        Foundation::HWND,
        Media::MediaFoundation::*,
        System::{
            Com::CoTaskMemFree,
            Threading::GetCurrentThreadId,
            WinRT::{RO_INIT_MULTITHREADED, RO_INIT_SINGLETHREADED, RoInitialize, RoUninitialize},
        },
        UI::{
            Controls::{
                TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TDCBF_CANCEL_BUTTON,
                TDF_ALLOW_DIALOG_CANCELLATION, TDF_POSITION_RELATIVE_TO_WINDOW,
                TDF_USE_COMMAND_LINKS, TaskDialogIndirect,
            },
            WindowsAndMessaging::{
                GA_ROOT, GetAncestor, GetWindowThreadProcessId, IsWindowVisible,
            },
        },
    },
    core::{GUID, HSTRING, PCWSTR, w},
};

use super::chooser_admission::{CameraChooser, NativeCameraChoice};
use super::{AmbientRuntime, CaptureAnchor, ExplorerCameraEnd, ExplorerCameraSession};
use crate::ambient_media_foundation::{Com, Mf};

const FIRST_CHOICE: i32 = 100;
const CANCEL: i32 = 2; // IDCANCEL
const MAX_DEVICES: usize = 16;

#[derive(Clone, Copy)]
enum Access {
    Allowed,
    NotAllowed,
}

fn allows(access: Option<AppCapabilityAccessStatus>) -> Access {
    match access {
        Some(AppCapabilityAccessStatus::Allowed) => Access::Allowed,
        _ => Access::NotAllowed,
    }
}

struct WinRt;
impl WinRt {
    fn enter() -> Option<Self> {
        // Balance each successful call (including S_FALSE). The UI thread
        // may already own an STA; use its apartment when explicitly reported.
        match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            Ok(()) => Some(Self),
            Err(error) if error.code().0 as u32 == 0x80010106 => {
                unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }
                    .ok()
                    .map(|_| Self)
            }
            Err(_) => None,
        }
    }
}
impl Drop for WinRt {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

fn webcam_allowed() -> bool {
    let Some(_apartment) = WinRt::enter() else {
        return false;
    };
    let access = AppCapability::Create(&HSTRING::from("webcam"))
        .and_then(|capability| capability.CheckAccess())
        .ok();
    matches!(allows(access), Access::Allowed)
}

struct Activations {
    ptr: *mut Option<IMFActivate>,
    len: usize,
}
impl Drop for Activations {
    fn drop(&mut self) {
        if self.ptr.is_null() {
            return;
        }
        // SAFETY: MF returns one owned COM reference per item, and ownership
        // of the array allocated by the COM task allocator.
        for i in 0..self.len {
            unsafe {
                std::ptr::drop_in_place(self.ptr.add(i));
            }
        }
        unsafe {
            CoTaskMemFree(Some(self.ptr.cast()));
        }
    }
}

fn attribute(
    attributes: &IMFActivate,
    key: &GUID,
    max_units: usize,
) -> Result<Vec<u16>, CameraIssue> {
    let size = unsafe { attributes.GetStringLength(key) }
        .map_err(|_| CameraIssue::DeviceUnavailable)? as usize;
    if size == 0 || size > max_units {
        return Err(CameraIssue::DeviceUnavailable);
    }
    let mut data = vec![0u16; size + 1];
    let mut observed = 0;
    unsafe { attributes.GetString(key, &mut data, Some(&mut observed)) }
        .map_err(|_| CameraIssue::DeviceUnavailable)?;
    if observed as usize != size || data[size] != 0 || data[..size].contains(&0) {
        return Err(CameraIssue::DeviceUnavailable);
    }
    data.truncate(size);
    Ok(data)
}

/// Run off the UI thread, before displaying the owned dialog. Enumerates
/// metadata without calling ActivateObject or MFCreateDeviceSource.
pub(crate) fn enumerate_choices() -> Result<Vec<NativeCameraChoice>, CameraIssue> {
    if !webcam_allowed() {
        return Err(CameraIssue::PermissionDenied);
    }
    let _com = Com::start()?;
    let _mf = Mf::start()?;
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, 1) }
        .map_err(|_| CameraIssue::DeviceUnavailable)?;
    let attributes = attributes.ok_or(CameraIssue::DeviceUnavailable)?;
    unsafe {
        attributes.SetGUID(
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        )
    }
    .map_err(|_| CameraIssue::DeviceUnavailable)?;
    let mut ptr = null_mut();
    let mut len = 0;
    unsafe { MFEnumDeviceSources(&attributes, &mut ptr, &mut len) }
        .map_err(|_| CameraIssue::DeviceUnavailable)?;
    let devices = Activations {
        ptr,
        len: len as usize,
    };
    if devices.ptr.is_null() || devices.len == 0 || devices.len > MAX_DEVICES {
        return Err(CameraIssue::DeviceUnavailable);
    }
    (0..devices.len)
        .map(|index| {
            let device = unsafe { &*devices.ptr.add(index) }
                .as_ref()
                .ok_or(CameraIssue::DeviceUnavailable)?;
            let label = String::from_utf16(&attribute(
                device,
                &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
                100,
            )?)
            .map_err(|_| CameraIssue::DeviceUnavailable)?;
            let unique = attribute(
                device,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                4096,
            )?;
            Ok(NativeCameraChoice {
                label,
                device_link: OsString::from_wide(&unique),
            })
        })
        .collect()
}

pub(crate) struct ConfirmedNativeChoice {
    choice: CameraChooser<(CaptureAnchor, u64)>,
    index: usize,
}

fn button_choice(button: i32, count: usize) -> Option<usize> {
    let index = usize::try_from(button.checked_sub(FIRST_CHOICE)?).ok()?;
    (index < count).then_some(index)
}

/// Accepts only a native application-owned top-level HWND on its owning
/// native UI thread. Never take an HWND supplied by the WebView. Buttons
/// select the exact native-enumerated snapshot; labels are not identities.
pub(crate) fn show_choice(
    owner: HWND,
    choice: CameraChooser<(CaptureAnchor, u64)>,
) -> Result<Option<ConfirmedNativeChoice>, CameraIssue> {
    let mut pid = 0;
    if owner.0.is_null()
        || unsafe { GetAncestor(owner, GA_ROOT) } != owner
        || unsafe { GetWindowThreadProcessId(owner, Some(&mut pid)) }
            != unsafe { GetCurrentThreadId() }
        || pid != std::process::id()
        || !unsafe { IsWindowVisible(owner) }.as_bool()
    {
        return Err(CameraIssue::DeviceUnavailable);
    }
    if !webcam_allowed() {
        return Err(CameraIssue::PermissionDenied);
    }
    let labels: Vec<Vec<u16>> = choice
        .labels()
        .map(|(index, label)| {
            format!("Choose camera {}: {}", index + 1, label.replace('&', "&&"))
                .encode_utf16()
                .chain([0])
                .collect()
        })
        .collect();
    let buttons: Vec<TASKDIALOG_BUTTON> = labels
        .iter()
        .enumerate()
        .map(|(i, label)| TASKDIALOG_BUTTON {
            nButtonID: FIRST_CHOICE + i as i32,
            pszButtonText: PCWSTR(label.as_ptr()),
        })
        .collect();
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: owner,
        pszWindowTitle: w!("AeRift camera choice"),
        pszMainInstruction: w!("Choose a camera for Explorer pickup"),
        pszContent: w!(
            "This does not start the camera. Return to the original Explorer window and explicitly start the session. A visible indicator stays on while AeRift uses the camera. Pickup does not send files."
        ),
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION
            | TDF_POSITION_RELATIVE_TO_WINDOW
            | TDF_USE_COMMAND_LINKS,
        dwCommonButtons: TDCBF_CANCEL_BUTTON,
        nDefaultButton: CANCEL,
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        ..Default::default()
    };
    let mut clicked = CANCEL;
    unsafe { TaskDialogIndirect(&config, Some(&mut clicked), None, None) }
        .map_err(|_| CameraIssue::DeviceUnavailable)?;
    Ok(button_choice(clicked, buttons.len()).map(|index| ConfirmedNativeChoice { choice, index }))
}

impl ConfirmedNativeChoice {
    /// A second deliberate native action in the original Explorer window
    /// consumes this value. No foreground manipulation and no auto-start.
    pub(crate) fn start(
        self,
        runtime: &AmbientRuntime,
        model: impl RgbLandmarker,
    ) -> Result<ExplorerCameraSession, ExplorerCameraEnd> {
        runtime.confirm_explorer_camera_choice(self.choice, Some(self.index), webcam_allowed, model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_result_only_maps_to_known_button_indices() {
        assert_eq!(button_choice(CANCEL, 2), None);
        assert_eq!(button_choice(i32::MIN, 2), None);
        assert_eq!(button_choice(FIRST_CHOICE, 2), Some(0));
        assert_eq!(button_choice(FIRST_CHOICE + 1, 2), Some(1));
        assert_eq!(button_choice(FIRST_CHOICE + 2, 2), None);
    }
    #[test]
    fn undocumented_or_unapproved_capability_status_fails_closed() {
        use AppCapabilityAccessStatus as S;
        assert!(matches!(allows(Some(S::Allowed)), Access::Allowed));
        for status in [
            None,
            Some(S::DeniedByUser),
            Some(S::DeniedBySystem),
            Some(S::UserPromptRequired),
            Some(S::NotDeclaredByApp),
        ] {
            assert!(matches!(allows(status), Access::NotAllowed));
        }
    }
}
