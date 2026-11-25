//! Native Windows qualification window, unreachable from normal app startup.
use std::{
    borrow::Cow,
    env, fs,
    io::{self, Write},
    os::windows::{ffi::OsStrExt, fs::MetadataExt},
    path::{Component, Path, PathBuf, Prefix},
    sync::{Arc, Mutex},
};

use aerift_peers::{Platform, RemotePeerNode};
use aerift_remote_wan::{
    OperatorDirect, QualificationAction, QualificationController, QualificationReply, WanSession,
};
use aerift_transfer::{ErrorCode, ReceiveLimits, TransferError};
use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    App, AppHandle, Assets, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    Wry,
};
use tauri_plugin_dialog::DialogExt;
use windows::{
    core::PCWSTR,
    Win32::{
        Storage::FileSystem::GetDriveTypeW,
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath, KF_FLAG_DONT_VERIFY},
    },
};

use crate::{
    private_remote_profile::PrivateRemoteProfile,
    wan_qualification_gate::{admitted_mode, ExitAction, ExitGate, LaunchMode},
};

// Operator-supplied build inputs for this one direct-only pilot. No runtime
// address inputs, logging, public directory, or relay configuration.
const DIRECT_BIND: Option<&str> = option_env!("AERIFT_TRUSTED_DIRECT_BIND");
const DIRECT_PEER_KEY: Option<&str> = option_env!("AERIFT_TRUSTED_DIRECT_PEER_KEY");
const DIRECT_PEER_ADDR: Option<&str> = option_env!("AERIFT_TRUSTED_DIRECT_PEER_ADDR");
// Never share the regular installation’s profile, keys, or WebView data.
const APPLICATION_ID: &str = "com.kgamazing44.aerift.wanpreview";
const RECEIVE_DIRECTORY: &str = "RemoteWanQualificationReceived";

const WINDOW: &str = "private-wan-qualification";
const DOCUMENT: &str = "remote-wan.html";
const DOCUMENT_PATH: &str = "/remote-wan.html";
const ASSETS: &[(&str, &[u8])] = &[
    (
        DOCUMENT_PATH,
        include_bytes!("wan_qualification_assets/remote-wan.html"),
    ),
    (
        "/remote-wan.css",
        include_bytes!("wan_qualification_assets/remote-wan.css"),
    ),
    (
        "/remote-wan.js",
        include_bytes!("wan_qualification_assets/remote-wan.js"),
    ),
];

struct QualificationAssets;
impl Assets<Wry> for QualificationAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        ASSETS
            .iter()
            .find(|(path, _)| *path == key.as_ref())
            .map(|(_, bytes)| Cow::Borrowed(*bytes))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(
            ASSETS
                .iter()
                .map(|(key, bytes)| (Cow::Borrowed(*key), Cow::Borrowed(*bytes))),
        )
    }
    fn csp_hashes(&self, _path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

fn allowed_document(url: &tauri::Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("http" | "https", Some("tauri.localhost")) | ("tauri", Some("localhost"))
    ) && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == DOCUMENT_PATH
        && url.query().is_none()
        && url.fragment().is_none()
}

enum PreviewController {
    Live(QualificationController),
    #[cfg(all(test, feature = "private-remote-wan-webview-smoke"))]
    OfflineSmoke {
        profile: Mutex<Option<PrivateRemoteProfile>>,
        card: String,
    },
}

impl PreviewController {
    async fn stop(&self) -> io::Result<()> {
        match self {
            Self::Live(live) => live.stop().await,
            #[cfg(all(test, feature = "private-remote-wan-webview-smoke"))]
            Self::OfflineSmoke { profile, .. } => {
                drop(profile.lock().map_err(|_| io::ErrorKind::Other)?.take());
                Ok(())
            }
        }
    }
}

#[tauri::command]
async fn private_wan_action(
    window: WebviewWindow,
    action: QualificationAction,
) -> Result<QualificationReply, TransferError> {
    if window.label() != WINDOW || !window.url().is_ok_and(|value| allowed_document(&value)) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let controller = window.state::<Arc<PreviewController>>().inner().clone();
    let live = match controller.as_ref() {
        PreviewController::Live(live) => live,
        #[cfg(all(test, feature = "private-remote-wan-webview-smoke"))]
        PreviewController::OfflineSmoke { card, .. } => {
            return match action {
                QualificationAction::Snapshot {} => Ok(QualificationReply::Snapshot {
                    card: card.clone(),
                    devices: vec![],
                    pending: None,
                    offers: vec![],
                }),
                _ => Err(ErrorCode::PeerUnavailable.into()),
            }
        }
    };
    live.execute(action, || async move {
        let display = window.clone();
        tauri::async_runtime::spawn_blocking(move || {
            display
                .dialog()
                .file()
                .set_parent(&display)
                .blocking_pick_file()
                .map(|file| {
                    file.into_path()
                        .map_err(|_| TransferError::from(ErrorCode::InvalidRequest))
                })
                .transpose()
        })
        .await
        .map_err(|_| TransferError::from(ErrorCode::InternalError))?
    })
    .await
}

fn normal_local_directory(path: &Path) -> io::Result<()> {
    const REPARSE_POINT: u32 = 0x400;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_attributes() & REPARSE_POINT != 0 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(())
}

fn native_app_local_data_base() -> io::Result<PathBuf> {
    // Same LocalAppData known folder used by Tauri's Windows path resolver.
    // No CLI or environment override may substitute the root.
    let buffer = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DONT_VERIFY, None) }
        .map_err(io::Error::other)?;
    if buffer.is_null() {
        return Err(io::ErrorKind::NotFound.into());
    }
    // The Windows API allocates a NUL-terminated string owned by our caller.
    let result = unsafe { buffer.to_string() }
        .map(PathBuf::from)
        .map_err(io::Error::other);
    unsafe { CoTaskMemFree(Some(buffer.0.cast())) };
    let path = result?;
    require_local_profile_base(&path)?;
    Ok(path)
}

fn require_local_profile_base(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || !matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let ancestors: Vec<_> = path.ancestors().collect();
    let drive = ancestors.last().ok_or(io::ErrorKind::InvalidInput)?;
    let wide = drive
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    // DRIVE_FIXED is 3. Reject mapped, removable and unknown hosts before filesystem I/O.
    const DRIVE_FIXED: u32 = 3;
    if unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } != DRIVE_FIXED {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    for ancestor in ancestors.into_iter().rev() {
        normal_local_directory(ancestor)?;
    }
    Ok(())
}

fn derive_offline_in_profile(root: &Path) -> Result<(PrivateRemoteProfile, String), ()> {
    normal_local_directory(root).map_err(|_| ())?;
    let locked = PrivateRemoteProfile::open(root).map_err(|_| ())?;
    let card = locked.offline_wan_card().map_err(|_| ())?;
    Ok((locked, card))
}

fn open_qualification_root() -> io::Result<PathBuf> {
    let root = native_app_local_data_base()?.join(APPLICATION_ID);
    match fs::create_dir(&root) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    normal_local_directory(&root)?;
    Ok(root)
}

fn show_offline_device_card() -> i32 {
    // First use may initialize the pilot profile and protected identity only.
    let card = open_qualification_root()
        .map_err(|_| ())
        .and_then(|root| derive_offline_in_profile(&root));
    if let Ok((_locked, public_card)) = card {
        if writeln!(io::stdout().lock(), "{public_card}").is_ok() {
            return 0;
        }
    }
    eprintln!("Could not display the offline pilot card. Close any other WAN preview and try again.");
    2
}

fn start_in_profile(root: &Path, direct: OperatorDirect) -> Result<WanSession, ()> {
    normal_local_directory(root).map_err(|_| ())?;
    // Lock the dedicated preview profile before creating the receive directory.
    let profile = PrivateRemoteProfile::open(root).map_err(|_| ())?;
    let destination = root.join(RECEIVE_DIRECTORY);
    match fs::create_dir(&destination) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(()),
    }
    normal_local_directory(&destination).map_err(|_| ())?;
    let (identity, trust, seed, profile_lock) = profile.into_wan_host_parts().map_err(|_| ())?;
    let node = RemotePeerNode::new(
        identity,
        "AeRift WAN qualification".into(),
        Platform::Windows,
        Arc::new(trust),
        &destination,
        ReceiveLimits {
            active_bytes: 64 * 1024 * 1024,
            session_offers: 4,
        },
    )
    .map_err(|_| ())?;
    tauri::async_runtime::block_on(WanSession::start_direct(node, seed, direct, profile_lock))
        .map_err(|_| ())
}

type ActiveSession = Arc<Mutex<Option<Arc<PreviewController>>>>;

fn shutdown_after_join(
    handle: AppHandle<Wry>,
    gate: Arc<ExitGate>,
    session: &ActiveSession,
    code: i32,
) {
    let session = session
        .lock()
        .unwrap_or_else(|state| state.into_inner())
        .take();
    tauri::async_runtime::spawn(async move {
        let failed = if let Some(session) = session {
            session.stop().await.is_err()
        } else {
            false
        };
        gate.completed();
        // AppHandle::exit can directly terminate on runtime failure. It is
        // safe to call it only after we have joined the WAN worker.
        handle.exit(if failed { 2 } else { code });
    });
}

fn private_context() -> tauri::Context<Wry> {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = APPLICATION_ID.into();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    context.set_assets(Box::new(QualificationAssets));
    context
}

fn private_window(app: &App<Wry>) -> WebviewWindowBuilder<'_, Wry, App<Wry>> {
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App(DOCUMENT.into()))
        .title("AeRift Remote · Private Preview")
        .inner_size(720.0, 720.0)
        .min_inner_size(420.0, 460.0)
        .on_navigation(allowed_document)
}

fn run_qualification_app(app: App<Wry>, session: ActiveSession, gate: Arc<ExitGate>) -> i32 {
    app.run_return(move |app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => match gate.requested() {
            ExitAction::Allow => {}
            ExitAction::WaitForShutdown => api.prevent_exit(),
            ExitAction::StartShutdown => {
                api.prevent_exit();
                shutdown_after_join(
                    app.clone(),
                    Arc::clone(&gate),
                    &session,
                    code.unwrap_or_default(),
                );
            }
        },
        _ => {}
    })
}

#[cfg(all(test, feature = "private-remote-wan-webview-smoke"))]
#[path = "private_remote_wan_windows_smoke.rs"]
mod windows_smoke;

/// Direct example entry; the ordinary app launcher does not call it.
pub(crate) fn run() -> i32 {
    match admitted_mode(env::args_os().skip(1)) {
        Some(LaunchMode::OfflineCard) => return show_offline_device_card(),
        Some(LaunchMode::Start) => {}
        None => {
            eprintln!("Explicit Windows WAN qualification mode is required.");
            return 2;
        }
    }
    let (Some(bind), Some(peer), Some(address)) = (DIRECT_BIND, DIRECT_PEER_KEY, DIRECT_PEER_ADDR)
    else {
        eprintln!("No approved direct route was set for this qualification build.");
        return 2;
    };
    let Ok(direct) = OperatorDirect::from_operator_config(bind, peer, address) else {
        eprintln!("Invalid direct route configuration.");
        return 2;
    };

    let Ok(app) = tauri::Builder::<Wry>::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![private_wan_action])
        .build(private_context())
    else {
        eprintln!("WAN qualification application could not start.");
        return 2;
    };
    let Ok(root) = open_qualification_root() else {
        eprintln!("WAN qualification could not open its dedicated preview profile.");
        return 2;
    };
    let Ok(session) = start_in_profile(&root, direct) else {
        eprintln!("WAN qualification could not open the protected profile or start the endpoint.");
        return 2;
    };

    let controller = Arc::new(PreviewController::Live(QualificationController::new(
        session,
    )));
    app.manage(Arc::clone(&controller));
    if private_window(&app).build().is_err() {
        let _ = tauri::async_runtime::block_on(controller.stop());
        eprintln!("WAN qualification window could not open.");
        return 2;
    }
    let session = Arc::new(Mutex::new(Some(controller)));
    run_qualification_app(app, session, Arc::new(ExitGate::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offline_wan_card_uses_only_protected_identity_and_lock() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        require_local_profile_base(root).unwrap();
        let card = derive_offline_in_profile(root).unwrap().1;
        assert!(card.starts_with("aerift-card-v1:"));
        assert_eq!(
            card.split(':').map(str::len).collect::<Vec<_>>(),
            [14, 64, 64]
        );
        assert_eq!(derive_offline_in_profile(root).unwrap().1, card);
        let held = crate::windows_storage::lock_profile(root).unwrap();
        assert!(derive_offline_in_profile(root).is_err());
        drop(held);
        let names: std::collections::BTreeSet<_> = fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            [
                "identity.dpapi",
                "remote-wan-endpoint-v1.dpapi",
                "session.lock",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect()
        );
        // Bad grant records would fail a trust-store read. Offline public
        // derivation must ignore them once the existing identity is present.
        for record in ["remote-trust-v1.dpapi", "remote-wan-trust-v1.dpapi"] {
            let file = root.join(record);
            fs::write(&file, b"synthetic invalid grant").unwrap();
            assert_eq!(derive_offline_in_profile(root).unwrap().1, card);
            assert_eq!(fs::read(file).unwrap(), b"synthetic invalid grant");
        }
        let context: tauri::Context<Wry> = tauri::generate_context!();
        assert_ne!(context.config().identifier, APPLICATION_ID);
        let pilot_context = private_context();
        assert_eq!(pilot_context.config().identifier, APPLICATION_ID);
        assert!(pilot_context.config().app.app_directories_override.is_none());
        for nonlocal in [r"\\remote.invalid\share", "relative"] {
            assert!(require_local_profile_base(Path::new(nonlocal)).is_err());
        }
    }

    #[test]
    fn qualification_command_accepts_only_its_exact_embedded_document() {
        for allowed in [
            "http://tauri.localhost/remote-wan.html",
            "tauri://localhost/remote-wan.html",
        ] {
            assert!(allowed_document(&tauri::Url::parse(allowed).unwrap()));
        }
        for denied in [
            "http://tauri.localhost/index.html",
            "http://tauri.localhost/remote-wan.html?x=1",
            "http://tauri.localhost/remote-wan.html#token",
            "https://wrong.invalid/remote-wan.html",
            "http://tauri.localhost:1420/remote-wan.html",
        ] {
            assert!(!allowed_document(&tauri::Url::parse(denied).unwrap()));
        }
    }
}
