//! Native Windows qualification executable only. No windows, IPC, or public listener.
use std::{
    env, fs,
    io::{self, Read},
    os::windows::fs::MetadataExt,
    path::Path,
    sync::{Arc, Mutex},
};

use aerift_peers::{Platform, RemotePeerNode};
use aerift_remote_wan::{OperatorRelay, WanSession};
use aerift_transfer::ReceiveLimits;
use tauri::{AppHandle, Manager, RunEvent, Wry};

use crate::{
    private_remote_profile::PrivateRemoteProfile,
    wan_qualification_gate::{admitted_args, ExitAction, ExitGate},
};

// One trusted build input. No runtime environment, files, URLs, or relay
// addresses from the CLI or a webview are accepted. Never print this value.
const OPERATOR_RELAY: Option<&str> = option_env!("AERIFT_TRUSTED_QUALIFICATION_RELAY");
const RECEIVE_DIRECTORY: &str = "RemoteWanQualificationReceived";

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

type ActiveSession = Arc<Mutex<Option<WanSession>>>;

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

fn request_shutdown(
    handle: AppHandle<Wry>,
    gate: Arc<ExitGate>,
    session: &ActiveSession,
    code: i32,
) {
    if gate.requested() == ExitAction::StartShutdown {
        shutdown_after_join(handle, gate, session, code);
    }
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
    let Ok(app) = tauri::Builder::<Wry>::default().build(context) else {
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

    let session = Arc::new(Mutex::new(Some(session)));
    let gate = Arc::new(ExitGate::default());
    app.run_return(move |app, event| match event {
        RunEvent::Ready => {
            // No commands, codes, or addresses are read from or sent to the
            // console. An input byte or EOF is only a local stop request.
            let handle = app.clone();
            let reader_gate = Arc::clone(&gate);
            let reader_session = Arc::clone(&session);
            if std::thread::Builder::new()
                .name("ae-wan-qualification-stop".into())
                .spawn(move || {
                    let _ = io::stdin().read(&mut [0_u8; 1]);
                    request_shutdown(handle, reader_gate, &reader_session, 0);
                })
                .is_err()
            {
                request_shutdown(app.clone(), Arc::clone(&gate), &session, 2);
            }
        }
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
