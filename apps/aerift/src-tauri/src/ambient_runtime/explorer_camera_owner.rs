//! Private Windows x64 tester wiring. The webview can permit two native
//! shortcuts but cannot choose a device, acquire a camera, or stage a file.
pub(crate) use super::explorer_camera_session::native_command::NativeCameraCommands;
use super::{AmbientRuntime, Ordering};
use aerift_transfer::{ErrorCode, TransferError};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

fn choose_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F8)
}
fn session_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F9)
}
fn available(app: &AppHandle) -> bool {
    app.path().resource_dir().ok().is_some_and(|root| {
        let model = root.join("ambient-camera-model");
        model.join("hand_landmarker.task").is_file() && model.join("libmediapipe.dll").is_file()
    })
}

pub(super) fn status(window: &WebviewWindow) -> Result<&'static str, TransferError> {
    let runtime = window.state::<AmbientRuntime>();
    let config = runtime
        .0
        .config
        .lock()
        .map_err(|_| ErrorCode::InternalError)?;
    Ok(if config.explorer_pickup_enabled {
        "enabled"
    } else if available(window.app_handle()) {
        "disabled"
    } else {
        "unavailable"
    })
}

pub(super) fn configure(window: &WebviewWindow, enabled: bool) -> Result<(), TransferError> {
    let app = window.app_handle();
    let runtime = window.state::<AmbientRuntime>();
    let mut cfg = runtime
        .0
        .config
        .lock()
        .map_err(|_| ErrorCode::InternalError)?;
    if enabled == cfg.explorer_pickup_enabled {
        return Ok(());
    }
    let global = app.global_shortcut();
    if enabled {
        if !cfg.enabled || cfg.paused || cfg.excludes.contains("explorer.exe") || !available(app) {
            return Err(ErrorCode::PeerUnavailable.into());
        }
        global
            .register(choose_key())
            .map_err(|_| ErrorCode::Conflict)?;
        if global.register(session_key()).is_err() {
            let _ = global.unregister(choose_key());
            return Err(ErrorCode::Conflict.into());
        }
        runtime.0.generation.fetch_add(1, Ordering::AcqRel);
        cfg.explorer_pickup_enabled = true;
        return Ok(());
    }
    // Revoke authority before any OS operation and invalidate any pending
    // chooser or active camera worker, including after a rapid off/on.
    cfg.explorer_pickup_enabled = false;
    runtime.0.generation.fetch_add(1, Ordering::AcqRel);
    let chooser = global.unregister(choose_key());
    let session = global.unregister(session_key());
    if chooser.is_err() || session.is_err() {
        return Err(ErrorCode::InternalError.into());
    }
    Ok(())
}

fn notify(app: &AppHandle, body: &'static str) {
    let _ = app
        .notification()
        .builder()
        .title("AeRift Explorer pickup")
        .body(body)
        .show();
}

pub(crate) fn handles(app: &AppHandle, key: &Shortcut, state: ShortcutState) -> bool {
    let select = key == &choose_key();
    if !select && key != &session_key() {
        return false;
    }
    // Consume these keys only in the separately compiled tester and never
    // accept a camera-selection/start command from a renderer.
    if state != ShortcutState::Pressed {
        return true;
    }
    let Some(commands) = app.try_state::<NativeCameraCommands>() else {
        return true;
    };
    let runtime = app.state::<AmbientRuntime>();
    if !select {
        match commands.request_stop_if_running() {
            Ok(true) => return true,
            Ok(false) => {}
            Err(_) => return true,
        }
        if commands.start(&runtime, app).is_err() {
            notify(
                app,
                "Session did not start. Choose a camera with Ctrl+Shift+F8 from the original Explorer window, return to it, then try again.",
            );
        }
        return true;
    }
    // Keep AeRift open behind Explorer. No focus is forced before or after
    // the native consent dialog. The subsequent start must revalidate the
    // original foreground anchor and permission.
    let Some(window) = app.get_webview_window("main") else {
        return true;
    };
    if window.is_visible().ok() != Some(true) {
        notify(
            app,
            "Open AeRift behind File Explorer before choosing a camera.",
        );
        return true;
    }
    let Ok(request) = commands.begin_choice(&runtime) else {
        notify(
            app,
            "Camera choice was not opened. Enable the Development setting and start from the Explorer window.",
        );
        return true;
    };
    let dispatch = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let inventory = NativeCameraCommands::device_metadata();
        let owner = dispatch.clone();
        let _ = dispatch.run_on_main_thread(move || {
            let runtime = owner.state::<AmbientRuntime>();
            let commands = owner.state::<NativeCameraCommands>();
            let result = window.hwnd().ok().map(|hwnd| {
                commands.finish_choice(
                    &runtime,
                    request,
                    windows::Win32::Foundation::HWND(hwnd.0),
                    inventory,
                )
            });
            if !matches!(result, Some(Ok(_))) {
                notify(&owner, "Camera choice was unavailable. Check Windows camera permission and try again from Explorer.");
            }
        });
    });
    true
}
