//! Native Windows qualification window, unreachable from normal app startup.
use std::{
    borrow::Cow,
    env, fs, io,
    os::windows::fs::MetadataExt,
    path::Path,
    sync::{Arc, Mutex},
};

use aerift_peers::{Platform, RemotePeerNode};
use aerift_remote_wan::{
    OperatorRelay, QualificationAction, QualificationController, QualificationReply, WanSession,
};
use aerift_transfer::{ErrorCode, ReceiveLimits, TransferError};
use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    AppHandle, Assets, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_plugin_dialog::DialogExt;

use crate::{
    private_remote_profile::PrivateRemoteProfile,
    wan_qualification_gate::{admitted_args, ExitAction, ExitGate},
};

// One trusted build input. No runtime environment, files, URLs, or relay
// addresses from the CLI or a webview are accepted. Never print this value.
const OPERATOR_RELAY: Option<&str> = option_env!("AERIFT_TRUSTED_QUALIFICATION_RELAY");
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

#[tauri::command]
async fn private_wan_action(
    window: WebviewWindow,
    action: QualificationAction,
) -> Result<QualificationReply, TransferError> {
    if window.label() != WINDOW || !window.url().is_ok_and(|value| allowed_document(&value)) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let controller = window
        .state::<Arc<QualificationController>>()
        .inner()
        .clone();
    controller
        .execute(action, || async move {
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

fn start_in_profile(root: &Path, relay: OperatorRelay) -> Result<WanSession, ()> {
    normal_local_directory(root).map_err(|_| ())?;
    // This is the same lock used by Nearby and the manually configured VPN
    // runtime. Open and retain it before creating the receive directory.
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
    tauri::async_runtime::block_on(WanSession::start(node, seed, relay, profile_lock))
        .map_err(|_| ())
}

type ActiveSession = Arc<Mutex<Option<Arc<QualificationController>>>>;

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

/// Direct example entry; the ordinary app launcher does not call it.
pub(crate) fn run() -> i32 {
    if !admitted_args(env::args_os().skip(1)) {
        eprintln!("Explicit Windows WAN qualification start is required.");
        return 2;
    }
    let Some(relay) =
        OPERATOR_RELAY.and_then(|value| OperatorRelay::from_operator_config(value).ok())
    else {
        eprintln!("No approved HTTPS relay was set for this qualification build.");
        return 2;
    };

    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    context.set_assets(Box::new(QualificationAssets));
    let Ok(app) = tauri::Builder::<Wry>::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![private_wan_action])
        .build(context)
    else {
        eprintln!("WAN qualification application could not start.");
        return 2;
    };
    let Ok(root) = app.path().app_local_data_dir() else {
        eprintln!("WAN qualification requires the existing AeRift profile.");
        return 2;
    };
    let Ok(session) = start_in_profile(&root, relay) else {
        eprintln!("WAN qualification could not open the protected profile or start the endpoint.");
        return 2;
    };

    let controller = Arc::new(QualificationController::new(session));
    app.manage(Arc::clone(&controller));
    if WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::App(DOCUMENT.into()))
        .title("AeRift Remote · Private Preview")
        .inner_size(720.0, 720.0)
        .min_inner_size(420.0, 460.0)
        .on_navigation(allowed_document)
        .build()
        .is_err()
    {
        let _ = tauri::async_runtime::block_on(controller.stop());
        eprintln!("WAN qualification window could not open.");
        return 2;
    }
    let session = Arc::new(Mutex::new(Some(controller)));
    let gate = Arc::new(ExitGate::default());
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

#[cfg(test)]
mod tests {
    use super::*;
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
