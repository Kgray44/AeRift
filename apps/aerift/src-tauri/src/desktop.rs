use crate::runtime::{AppRuntime, TransferView};
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
    enabled: AtomicBool,
    route: Mutex<Option<Channel<&'static str>>>,
    shortcut: Mutex<Option<Shortcut>>,
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
        &[&show, &rift, &activity, &preview, &status, &divider, &quit],
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
        enabled: AtomicBool::new(false),
        route: Mutex::new(None),
        shortcut: Mutex::new(None),
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
    Ok(())
}

pub(crate) fn handle_shortcut(app: &AppHandle, state: ShortcutState) {
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
) {
    let Some(ambient) = app.try_state::<Ambient>() else {
        return;
    };
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

fn show_transfer_preview(app: &AppHandle) -> tauri::Result<()> {
    const LABEL: &str = "desktop-transfer-preview";
    const WIDTH: f64 = 360.0;
    const HEIGHT: f64 = 224.0;
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }

    let preview = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?surface=desktop-preview".into()),
    )
    .title("AeRift transfer preview")
    .inner_size(WIDTH, HEIGHT)
    .visible(false)
    .focused(false)
    .focusable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .build()?;
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten());
    let monitor = match monitor {
        Some(current) => Some(current),
        None => preview.primary_monitor().unwrap_or(None),
    };
    if let Some(monitor) = monitor {
        let work = monitor.work_area();
        let scale = monitor.scale_factor();
        let margin = (16.0 * scale).round() as i32;
        let x = work.position.x + work.size.width as i32 - (WIDTH * scale).round() as i32 - margin;
        let y =
            work.position.y + work.size.height as i32 - (HEIGHT * scale).round() as i32 - margin;
        let _ = preview.set_position(PhysicalPosition::new(
            x.max(work.position.x),
            y.max(work.position.y),
        ));
    }
    if let Err(error) = preview.show() {
        let _ = preview.destroy();
        return Err(error);
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(7)).await;
        let _ = preview.destroy();
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn desktop_transfer_preview(
    runtime: tauri::State<'_, AppRuntime>,
    transfer_id: Option<String>,
) -> Option<TransferView> {
    runtime.desktop_transfer_preview(transfer_id.as_deref())
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
