#[path = "ambient_overlay_placement.rs"]
mod overlay_placement;
use overlay_placement::{Bounds, Corner};

use crate::{
    ambient_runtime::{self, AmbientRuntime},
    runtime::{AmbientTransferProjection, AppRuntime},
};
use aerift_transfer::{ErrorCode, TransferError};
use std::{
    os::windows::ffi::OsStrExt,
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    ipc::Channel,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    App, AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, Window,
    WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
    System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    },
    UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "AeRift";

struct Ambient {
    tray: TrayIcon,
    status: MenuItem<Wry>,
    capture_pause: MenuItem<Wry>,
    enabled: AtomicBool,
    route: Mutex<Option<Channel<&'static str>>>,
    shortcut: Mutex<Option<Shortcut>>,
    preview_corner: Mutex<Corner>,
}

pub(crate) fn install_tray(app: &App) -> tauri::Result<()> {
    let status = MenuItem::with_id(
        app,
        "aerift-ambient-status",
        "Connecting",
        false,
        None::<&str>,
    )?;
    let show = MenuItem::with_id(
        app,
        "aerift-ambient-show",
        "Open AeRift",
        true,
        None::<&str>,
    )?;
    let rift = MenuItem::with_id(
        app,
        "aerift-ambient-rift",
        "Open the Rift",
        true,
        None::<&str>,
    )?;
    let activity = MenuItem::with_id(
        app,
        "aerift-ambient-activity",
        "Transfer activity",
        true,
        None::<&str>,
    )?;
    let preview = MenuItem::with_id(
        app,
        "aerift-ambient-preview",
        "Show transfer preview",
        true,
        None::<&str>,
    )?;
    let capture_pause = MenuItem::with_id(
        app,
        "aerift-capture-pause",
        "Pause Ambient capture",
        true,
        None::<&str>,
    )?;
    let divider = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        "aerift-ambient-quit",
        "Quit AeRift",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &rift,
            &activity,
            &preview,
            &capture_pause,
            &status,
            &divider,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("aerift-desktop")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("AeRift")
        .on_menu_event(handle_menu);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    tray.set_visible(false)?;
    app.manage(Ambient {
        tray,
        status,
        capture_pause,
        enabled: AtomicBool::new(false),
        route: Mutex::new(None),
        shortcut: Mutex::new(None),
        preview_corner: Mutex::default(),
    });
    Ok(())
}

fn handle_menu(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let route = match event.id().as_ref() {
        "aerift-ambient-show" => None,
        "aerift-ambient-rift" => Some("rift"),
        "aerift-ambient-activity" => Some("activity"),
        "aerift-ambient-preview" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = show_transfer_preview(&app);
            });
            return;
        }
        "aerift-capture-pause" => {
            if let Some(paused) = app.state::<AmbientRuntime>().toggle_paused() {
                if let Some(ambient) = app.try_state::<Ambient>() {
                    let _ = ambient.capture_pause.set_text(if paused {
                        "Resume Ambient capture"
                    } else {
                        "Pause Ambient capture"
                    });
                }
            }
            return;
        }
        "aerift-ambient-quit" => {
            app.exit(0);
            return;
        }
        _ => return,
    };
    show_main(app, route);
}

pub(crate) fn show_main(app: &AppHandle, route: Option<&'static str>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    if let Some(route) = route {
        if let Some(ambient) = app.try_state::<Ambient>() {
            if let Ok(listener) = ambient.route.lock() {
                if let Some(listener) = listener.as_ref() {
                    let _ = listener.send(route);
                }
            }
        }
    }
}

pub(crate) fn handle_window(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window
            .try_state::<Ambient>()
            .is_some_and(|ambient| ambient.enabled.load(Ordering::Acquire))
            && window.hide().is_ok()
        {
            api.prevent_close();
        }
    }
}

#[tauri::command]
pub(crate) fn watch_desktop_ambient(app: AppHandle, route: Channel<&'static str>) -> bool {
    let Some(ambient) = app.try_state::<Ambient>() else {
        return false;
    };
    let Ok(mut listener) = ambient.route.lock() else {
        return false;
    };
    *listener = Some(route);
    true
}

#[tauri::command]
pub(crate) fn set_desktop_ambient(app: AppHandle, enabled: bool) -> Result<(), TransferError> {
    let ambient = app.try_state::<Ambient>().ok_or(ErrorCode::InternalError)?;
    ambient
        .tray
        .set_visible(enabled)
        .map_err(|_| ErrorCode::InternalError)?;
    ambient.enabled.store(enabled, Ordering::Release);
    if enabled {
        // Native discovery and transport are not owned by a webview subscription.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(root) = app.path().app_local_data_dir() {
                let _ = app.state::<AppRuntime>().session(root).await;
            }
        });
    }
    Ok(())
}

pub(crate) fn handle_shortcut(app: &AppHandle, key: &Shortcut, state: ShortcutState) {
    if key == &ambient_runtime::capture_shortcut() {
        if state == ShortcutState::Pressed {
            app.state::<AmbientRuntime>().request_pickup();
        }
        return;
    }
    if state == ShortcutState::Pressed
        && app
            .try_state::<Ambient>()
            .is_some_and(|ambient| ambient.enabled.load(Ordering::Acquire))
    {
        show_main(app, Some("rift"));
    }
}

#[tauri::command]
pub(crate) async fn set_desktop_shortcut(
    app: AppHandle,
    choice: String,
) -> Result<(), TransferError> {
    let next = match choice.as_str() {
        "off" => None,
        "alt-shift-r" => Some(Shortcut::new(
            Some(Modifiers::ALT | Modifiers::SHIFT),
            Code::KeyR,
        )),
        "ctrl-alt-r" => Some(Shortcut::new(
            Some(Modifiers::CONTROL | Modifiers::ALT),
            Code::KeyR,
        )),
        _ => return Err(ErrorCode::InvalidRequest.into()),
    };
    let ambient = app.try_state::<Ambient>().ok_or(ErrorCode::InternalError)?;
    let mut current = ambient
        .shortcut
        .lock()
        .map_err(|_| ErrorCode::InternalError)?;
    if *current == next {
        return Ok(());
    }
    let global = app.global_shortcut();
    if let Some(shortcut) = next {
        global.register(shortcut).map_err(|_| ErrorCode::Conflict)?;
    }
    if let Some(previous) = *current {
        if global.unregister(previous).is_err() {
            if let Some(shortcut) = next {
                let _ = global.unregister(shortcut);
            }
            return Err(ErrorCode::InternalError.into());
        }
    }
    *current = next;
    Ok(())
}

#[tauri::command]
pub(crate) fn update_desktop_ambient(
    app: AppHandle,
    connected: Option<usize>,
    transfers: usize,
    gesture: String,
    preview_corner: Option<String>,
) {
    let Some(ambient) = app.try_state::<Ambient>() else {
        return;
    };
    if let Some(corner) = preview_corner.as_deref().and_then(Corner::parse) {
        if let Ok(mut current) = ambient.preview_corner.lock() {
            *current = corner;
        }
    }
    let camera = match gesture.as_str() {
        "active" => "Camera active",
        "enabled" => "Gestures enabled",
        _ => "Gestures off",
    };
    let status = match connected {
        Some(count) => format!("{count} connected · {transfers} active · {camera}"),
        None => format!("Connection unavailable · {camera}"),
    };
    let _ = ambient.status.set_text(&status);
    let _ = ambient.tray.set_tooltip(Some(format!("AeRift · {status}")));
}

const PREVIEW_LABEL: &str = "desktop-transfer-preview";

fn place_transfer_preview(preview: &tauri::WebviewWindow) -> Option<()> {
    if !preview.state::<AmbientRuntime>().allows_overlay() {
        return None;
    }
    use windows_sys::Win32::{
        Foundation::RECT,
        UI::WindowsAndMessaging::{GetForegroundWindow, GetShellWindow, GetWindowRect},
    };

    // Read only the foreground window bounds. Never sample desktop pixels,
    // attach to a process, change window activation, or inspect window titles.
    let active = unsafe { GetForegroundWindow() };
    if active.is_null() {
        return None;
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(active, &mut rect) } == 0 {
        return None;
    }
    let mut center = (
        (f64::from(rect.left) + f64::from(rect.right)) / 2.0,
        (f64::from(rect.top) + f64::from(rect.bottom)) / 2.0,
    );
    let shell = unsafe { GetShellWindow() };
    if active == shell {
        let pointer = preview.cursor_position().ok()?;
        center = (pointer.x, pointer.y);
    }
    let monitor = preview.monitor_from_point(center.0, center.1).ok()??;
    let bounds = monitor.position();
    let display = monitor.size();
    let work = monitor.work_area();
    let active = if active != shell {
        Some(Bounds {
            x: rect.left,
            y: rect.top,
            w: u32::try_from(rect.right.checked_sub(rect.left)?).ok()?,
            h: u32::try_from(rect.bottom.checked_sub(rect.top)?).ok()?,
        })
    } else {
        None
    };
    let ambient = preview.try_state::<Ambient>()?;
    if !ambient.enabled.load(Ordering::Acquire) {
        return None;
    }
    let corner = *ambient.preview_corner.lock().ok()?;
    let (x, y, width, height) = overlay_placement::place(
        active,
        Bounds {
            x: bounds.x,
            y: bounds.y,
            w: display.width,
            h: display.height,
        },
        Bounds {
            x: work.position.x,
            y: work.position.y,
            w: work.size.width,
            h: work.size.height,
        },
        monitor.scale_factor(),
        corner,
    )?;
    let position = PhysicalPosition::new(x, y);
    let size = tauri::PhysicalSize::new(width, height);
    if preview.outer_position().ok()? != position {
        preview.set_position(position).ok()?;
    }
    if preview.inner_size().ok()? != size {
        preview.set_size(size).ok()?;
    }
    Some(())
}

fn show_transfer_preview(app: &AppHandle) -> tauri::Result<()> {
    // User-initiated tray command. No observer or transparent window when idle.
    if app.get_webview_window(PREVIEW_LABEL).is_some()
        || app
            .state::<AppRuntime>()
            .desktop_transfer_projection(None)
            .is_none()
    {
        return Ok(());
    }
    let preview = WebviewWindowBuilder::new(
        app,
        PREVIEW_LABEL,
        WebviewUrl::App("index.html?surface=desktop-preview".into()),
    )
    .title("AeRift Ambient transfer")
    .inner_size(overlay_placement::WIDTH, overlay_placement::HEIGHT)
    .visible(false)
    .focused(false)
    .focusable(false)
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .build()?;
    if let Err(error) = preview.set_ignore_cursor_events(true) {
        let _ = preview.destroy();
        return Err(error);
    }
    if place_transfer_preview(&preview).is_none() {
        let _ = preview.destroy();
        return Ok(());
    }
    if let Err(error) = preview.show() {
        let _ = preview.destroy();
        return Err(error);
    }
    tauri::async_runtime::spawn(async move {
        // Bounded opt-in preview, refreshed only while actively shown. Keep all
        // Win32 geometry access on the UI thread and suppress on uncertainty.
        for _ in 0..120 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let window = preview.clone();
            if preview
                .run_on_main_thread(move || {
                    if place_transfer_preview(&window).is_none() {
                        let _ = window.destroy();
                    }
                })
                .is_err()
            {
                break;
            }
            if preview.is_visible().ok() != Some(true) {
                break;
            }
        }
        let _ = preview.destroy();
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn desktop_transfer_preview(
    webview: tauri::WebviewWindow,
    runtime: tauri::State<'_, AppRuntime>,
    updates: Channel<Option<AmbientTransferProjection>>,
) {
    if webview.label() == PREVIEW_LABEL {
        runtime.watch_ambient_projection(webview, updates);
    }
}

#[tauri::command]
pub(crate) fn notify_desktop_incoming(app: AppHandle, count: usize) {
    let Some(ambient) = app.try_state::<Ambient>() else {
        return;
    };
    let hidden = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        == Some(false);
    if count == 0 || !ambient.enabled.load(Ordering::Acquire) || !hidden {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("Incoming AeRift transfer")
        .body("Open Transfer activity from the AeRift notification area to review.")
        .show();
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[tauri::command]
pub(crate) fn open_workspace_url(url: String) -> Result<(), TransferError> {
    let parsed = tauri::Url::parse(&url).map_err(|_| ErrorCode::InvalidRequest)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let operation = wide("open");
    let address = wide(parsed.as_str());
    // A qualified HTTP(S) URL is sent directly to the OS handler with no shell interpolation.
    let result = unsafe {
        ShellExecuteW(
            null_mut(),
            operation.as_ptr(),
            address.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err(ErrorCode::InternalError.into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn desktop_startup_enabled() -> Result<bool, TransferError> {
    let key = wide(RUN_KEY);
    let name = wide(RUN_VALUE);
    let mut bytes = 0;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            null_mut(),
            &mut bytes,
        )
    };
    match result {
        ERROR_SUCCESS => Ok(true),
        ERROR_FILE_NOT_FOUND => Ok(false),
        _ => Err(ErrorCode::StorageFailed.into()),
    }
}

#[tauri::command]
pub(crate) fn set_desktop_startup(enabled: bool) -> Result<bool, TransferError> {
    let key = wide(RUN_KEY);
    let name = wide(RUN_VALUE);
    let result = if enabled {
        let executable = std::env::current_exe().map_err(|_| ErrorCode::InternalError)?;
        let mut command = vec![u16::from(b'"')];
        command.extend(executable.as_os_str().encode_wide());
        command.extend([u16::from(b'"'), 0]);
        let bytes = u32::try_from(command.len() * size_of::<u16>())
            .map_err(|_| ErrorCode::InternalError)?;
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                command.as_ptr().cast(),
                bytes,
            )
        }
    } else {
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) }
    };
    if result == ERROR_SUCCESS || (!enabled && result == ERROR_FILE_NOT_FOUND) {
        desktop_startup_enabled()
    } else {
        Err(ErrorCode::StorageFailed.into())
    }
}
