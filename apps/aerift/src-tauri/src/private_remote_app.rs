//! Windows private overlay mode and the separately admitted developer qualifier.
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::Duration,
};

use aerift_peers::{Device, Platform, RemotePeerNode};
use aerift_transfer::{
    ErrorCode, PeerId, ReceiveLimits, State, Status, TransferError, TransferKey,
};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};
#[cfg(feature = "private-remote-app")]
use tauri::{WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_dialog::DialogExt;
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    private_remote_profile::{overlay_endpoint, PrivateRemoteProfile},
    protected_store::ProtectedFile,
    windows_storage::storage_failed,
};

#[cfg(any(test, feature = "private-remote-app"))]
const FLAG: &str = "--private-remote-dev";
const BYTES: u64 = 256 * 1024 * 1024;

#[cfg(any(test, feature = "private-remote-app"))]
pub(crate) fn launch_endpoint(
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> Result<Option<SocketAddr>, TransferError> {
    let args: Vec<_> = args.into_iter().collect();
    if !args.iter().any(|arg| arg == FLAG) {
        return Ok(None);
    }
    let [flag, value] = args.as_slice() else {
        return Err(ErrorCode::InvalidRequest.into());
    };
    if flag != FLAG {
        return Err(ErrorCode::InvalidRequest.into());
    }
    overlay_endpoint(value.to_str().ok_or(ErrorCode::InvalidRequest)?).map(Some)
}

#[cfg(feature = "private-remote-app")]
pub(crate) fn run(endpoint: SocketAddr, mut context: tauri::Context<Wry>) {
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    tauri::Builder::default()
        .manage({
            let runtime = RemoteRuntime { developer: true, ..Default::default() };
            runtime.configure(Ok(Some(endpoint)));
            runtime
        })
        .invoke_handler(tauri::generate_handler![
            private_remote_snapshot,
            private_remote_start,
            private_remote_action,
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("AeRift • Private Remote Development")
                .inner_size(820.0, 700.0)
                .min_inner_size(540.0, 450.0)
                .on_navigation(embedded_origin)
                .initialization_script("Object.defineProperty(window,'__AERIFT_PRIVATE_REMOTE_DEV__',{value:true, writable:false})")
                .build()?;
            Ok(())
        })
        .run(context)
        .expect("failed to launch private Remote developer window");
}

#[derive(Default)]
pub(crate) struct RemoteRuntime {
    launch: OnceLock<LaunchMode>,
    session: Mutex<Option<DevSession>>,
    outbound: Mutex<()>,
    developer: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LaunchMode {
    Nearby,
    Remote(SocketAddr),
    Unavailable,
}

impl RemoteRuntime {
    pub(crate) fn configure(&self, preference: Result<Option<SocketAddr>, TransferError>) {
        let mode = match preference {
            Ok(None) => LaunchMode::Nearby,
            Ok(Some(endpoint)) => LaunchMode::Remote(endpoint),
            Err(_) => LaunchMode::Unavailable,
        };
        let _ = self.launch.set(mode);
    }

    fn mode(&self) -> LaunchMode {
        self.launch
            .get()
            .copied()
            .unwrap_or(LaunchMode::Unavailable)
    }

    fn endpoint(&self) -> Result<SocketAddr, TransferError> {
        match self.mode() {
            LaunchMode::Remote(endpoint) => Ok(endpoint),
            _ => Err(ErrorCode::PeerUnavailable.into()),
        }
    }
}

const MODE_STORE: &str = "windows-private-remote-mode-v1.dpapi";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ModePreference {
    version: u8,
    endpoint: Option<String>,
}

fn read_mode(file: &ProtectedFile) -> Result<Option<SocketAddr>, TransferError> {
    let Some(data) = file.load().map_err(storage_failed)? else {
        return Ok(None);
    };
    let mode: ModePreference = serde_json::from_slice(&data).map_err(storage_failed)?;
    if mode.version != 1 {
        return Err(ErrorCode::StorageFailed.into());
    }
    mode.endpoint.as_deref().map(overlay_endpoint).transpose()
}

pub(crate) fn load_mode(app: &tauri::AppHandle) -> Result<Option<SocketAddr>, TransferError> {
    let root = app.path().app_local_data_dir().map_err(storage_failed)?;
    read_mode(&ProtectedFile::new(&root, MODE_STORE))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModeView {
    current: &'static str,
    next_endpoint: Option<String>,
    restart_needed: bool,
}

#[tauri::command]
pub(crate) async fn windows_remote_mode(window: WebviewWindow) -> Result<ModeView, TransferError> {
    require_remote_origin(&window)?;
    let runtime = window.state::<RemoteRuntime>();
    let current = runtime.mode();
    let next = load_mode(window.app_handle());
    let next_endpoint = next.as_ref().ok().and_then(|value| *value);
    let next_mode = match next {
        Ok(value) => value.map_or(LaunchMode::Nearby, LaunchMode::Remote),
        Err(_) => LaunchMode::Unavailable,
    };
    Ok(ModeView {
        current: match current {
            LaunchMode::Nearby => "nearby",
            LaunchMode::Remote(_) => "remote",
            LaunchMode::Unavailable => "unavailable",
        },
        next_endpoint: next_endpoint.map(|endpoint| endpoint.to_string()),
        restart_needed: current != next_mode && next_mode != LaunchMode::Unavailable,
    })
}

#[tauri::command]
pub(crate) async fn windows_set_remote_mode(
    window: WebviewWindow,
    endpoint: Option<String>,
    confirmed: bool,
) -> Result<(), TransferError> {
    require_remote_origin(&window)?;
    if !confirmed {
        return Err(ErrorCode::Cancelled.into());
    }
    let endpoint = endpoint.as_deref().map(overlay_endpoint).transpose()?;
    let root = window.path().app_local_data_dir().map_err(storage_failed)?;
    let data = serde_json::to_vec(&ModePreference {
        version: 1,
        endpoint: endpoint.map(|value| value.to_string()),
    })
    .map_err(storage_failed)?;
    tauri::async_runtime::spawn_blocking(move || {
        ProtectedFile::new(&root, MODE_STORE)
            .replace_write_through(&data)
            .map_err(storage_failed)
    })
    .await
    .map_err(|_| ErrorCode::InternalError)?
}

#[tauri::command]
pub(crate) async fn windows_exit_for_remote_mode(
    window: WebviewWindow,
) -> Result<(), TransferError> {
    let view = windows_remote_mode(window.clone()).await?;
    if !view.restart_needed {
        return Err(ErrorCode::Conflict.into());
    }
    if view.current == "remote" {
        private_remote_action(window.clone(), Action::Stop).await?;
    }
    window.app_handle().exit(0);
    Ok(())
}

struct DevSession {
    node: Arc<RemotePeerNode>,
    stop: CancellationToken,
    task: JoinHandle<Result<(), TransferError>>,
    profile: Arc<std::fs::File>,
    folders: Option<Arc<folder_mode::FolderMode>>,
}

impl Drop for DevSession {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    active: bool,
    endpoint: String,
    identity: Option<PeerId>,
    peers: Vec<Device>,
    pairing: Option<Pending>,
    offers: Vec<OfferView>,
    folders_available: bool,
    folders_active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    id: Uuid,
    peer: Device,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfferView {
    peer_id: PeerId,
    id: Uuid,
    name: String,
    size_bytes: u64,
    status: Status,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Action {
    CreateInvite {
        peer_id: PeerId,
    },
    CancelInvite,
    ConfirmPairing {
        id: Uuid,
        accepted: bool,
    },
    Revoke {
        peer_id: PeerId,
    },
    Respond {
        peer_id: PeerId,
        id: Uuid,
        accepted: bool,
    },
    Stop,
}

#[derive(Serialize)]
pub(crate) struct ActionResult {
    invite: Option<String>,
}

fn embedded_origin(url: &tauri::Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("http" | "https", Some("tauri.localhost")) | ("tauri", Some("localhost"))
    ) && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
}

fn require_remote_origin(window: &WebviewWindow) -> Result<(), TransferError> {
    if window.label() != "main" || !window.url().is_ok_and(|url| embedded_origin(&url)) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn private_remote_snapshot(
    window: WebviewWindow,
) -> Result<Snapshot, TransferError> {
    require_remote_origin(&window)?;
    let runtime = window.state::<RemoteRuntime>();
    let session = runtime.session.lock().await;
    let mut result = Snapshot {
        active: false,
        endpoint: runtime.endpoint()?.to_string(),
        identity: None,
        peers: Vec::new(),
        pairing: None,
        offers: Vec::new(),
        folders_available: !runtime.developer,
        folders_active: false,
    };
    let Some(session) = session
        .as_ref()
        .filter(|session| !session.task.is_finished())
    else {
        return Ok(result);
    };
    result.active = true;
    result.folders_active = session.folders.is_some();
    result.identity = Some(session.node.device().id);
    result.peers = session.node.trusted_devices();
    result.peers.sort_by_key(|peer| peer.id.to_string());
    result.pairing = session
        .node
        .subscribe_pairing()
        .borrow()
        .clone()
        .map(|request| Pending {
            id: request.id,
            peer: request.device,
        });
    result.offers = session
        .node
        .transfers()
        .into_iter()
        .map(|transfer| OfferView {
            peer_id: transfer.key.peer,
            id: transfer.key.id,
            name: transfer.offer.name,
            size_bytes: transfer.offer.size_bytes,
            status: transfer.status,
        })
        .collect();
    result
        .offers
        .sort_by_key(|offer| (offer.peer_id.to_string(), offer.id));
    Ok(result)
}

fn initialize_profile(
    root: PathBuf,
    developer: bool,
) -> Result<(Arc<RemotePeerNode>, std::fs::File), TransferError> {
    std::fs::create_dir_all(&root).map_err(|_| ErrorCode::StorageFailed)?;
    let profile = PrivateRemoteProfile::open(&root)?;
    let received = root.join(if developer {
        "RemoteQualificationReceived"
    } else {
        "RemoteReceived"
    });
    std::fs::create_dir_all(&received).map_err(|_| ErrorCode::StorageFailed)?;
    let (identity, trust, lock) = profile.into_host_parts()?;
    let node = RemotePeerNode::new(
        identity,
        "AeRift Windows".into(),
        Platform::Windows,
        Arc::new(trust),
        &received,
        ReceiveLimits {
            active_bytes: BYTES,
            session_offers: 8,
        },
    )?;
    Ok((Arc::new(node), lock))
}

#[tauri::command]
pub(crate) async fn private_remote_start(
    window: WebviewWindow,
    confirmed: bool,
    enable_folders: Option<bool>,
) -> Result<(), TransferError> {
    require_remote_origin(&window)?;
    if !confirmed {
        return Err(ErrorCode::Cancelled.into());
    }
    let runtime = window.state::<RemoteRuntime>();
    let endpoint = runtime.endpoint()?;
    let developer = runtime.developer;
    let _outbound = runtime
        .outbound
        .try_lock()
        .map_err(|_| ErrorCode::Conflict)?;
    let mut slot = runtime.session.lock().await;
    if slot
        .as_ref()
        .is_some_and(|session| session.task.is_finished())
    {
        slot.take();
    }
    if slot.is_some() {
        return Err(ErrorCode::Conflict.into());
    }
    let root = window
        .path()
        .app_local_data_dir()
        .map_err(|_| ErrorCode::StorageFailed)?;
    let folder_root = root.clone();
    let (node, lock) =
        tauri::async_runtime::spawn_blocking(move || initialize_profile(root, developer))
            .await
            .map_err(|_| ErrorCode::InternalError)??;
    let folders = if enable_folders == Some(true) && !developer {
        Some(Arc::new(
            tauri::async_runtime::spawn_blocking(move || {
                folder_mode::FolderMode::open(&folder_root)
            })
            .await
            .map_err(|_| ErrorCode::InternalError)??,
        ))
    } else {
        None
    };
    // This is the immutable, exact overlay endpoint admitted at app startup.
    // A missing interface or occupied port does not fall back to any address.
    let listener = TcpListener::bind(endpoint)
        .await
        .map_err(|_| ErrorCode::NetworkError)?;
    let stop = CancellationToken::new();
    let task = tokio::spawn({
        let (node, stop) = (node.clone(), stop.clone());
        let folder_ingress = folders.as_ref().map(|mode| mode.ingress.clone());
        async move {
            if let Some(folders) = folder_ingress {
                return node.serve_with_folders(listener, stop, folders).await;
            }
            node.serve(listener, stop).await
        }
    });
    *slot = Some(DevSession {
        node,
        stop,
        task,
        profile: Arc::new(lock),
        folders,
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn private_remote_action(
    window: WebviewWindow,
    request: Action,
) -> Result<ActionResult, TransferError> {
    require_remote_origin(&window)?;
    let runtime = window.state::<RemoteRuntime>();
    runtime.endpoint()?;
    let mut slot = runtime.session.lock().await;
    let mut reply = ActionResult { invite: None };
    if matches!(request, Action::Stop) {
        let Some(mut session) = slot.take() else {
            return Ok(reply);
        };
        session.stop.cancel();
        // A v2 finalize may already run on a blocking worker after the
        // listener aborts its HTTP task. Close publication before returning
        // Stop, without changing saved Remote grants or blocking the UI.
        let node = session.node.clone();
        let barrier_lock = session.profile.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _profile = barrier_lock;
            node.stop_receiving();
        })
        .await
        .map_err(|_| ErrorCode::InternalError)?;
        // Keep the exclusive old profile lock until listener shutdown completes.
        (&mut session.task)
            .await
            .map_err(|_| ErrorCode::InternalError)??;
        return Ok(reply);
    }
    let node = slot
        .as_ref()
        .filter(|session| !session.task.is_finished())
        .ok_or(ErrorCode::PeerUnavailable)?
        .node
        .clone();
    reply = tauri::async_runtime::spawn_blocking(move || {
        let mut result = ActionResult { invite: None };
        match request {
            Action::CreateInvite { peer_id } => {
                result.invite = Some(node.create_invitation(peer_id)?.code)
            }
            Action::CancelInvite => node.cancel_invitation(),
            Action::ConfirmPairing { id, accepted } => node.confirm_pairing(id, accepted)?,
            Action::Revoke { peer_id } => node.revoke(peer_id)?,
            Action::Respond {
                peer_id,
                id,
                accepted,
            } => {
                let key = TransferKey { peer: peer_id, id };
                if !node
                    .transfers()
                    .iter()
                    .any(|offer| offer.key == key && offer.status.state == State::Pending)
                {
                    return Err(ErrorCode::Conflict.into());
                }
                node.respond(key, accepted)?;
            }
            Action::Stop => unreachable!("handled above"),
        }
        Ok::<_, TransferError>(result)
    })
    .await
    .map_err(|_| ErrorCode::InternalError)??;
    Ok(reply)
}

async fn active_host(
    runtime: &RemoteRuntime,
) -> Result<(Arc<RemotePeerNode>, CancellationToken, Arc<std::fs::File>), TransferError> {
    runtime.endpoint()?;
    runtime
        .session
        .lock()
        .await
        .as_ref()
        .filter(|session| !session.task.is_finished())
        .map(|session| {
            (
                session.node.clone(),
                session.stop.child_token(),
                session.profile.clone(),
            )
        })
        .ok_or_else(|| ErrorCode::PeerUnavailable.into())
}

#[tauri::command]
pub(crate) async fn windows_redeem_remote(
    window: WebviewWindow,
    endpoint: String,
    invite: String,
    expected_issuer: PeerId,
) -> Result<(), TransferError> {
    require_remote_origin(&window)?;
    let route = overlay_endpoint(&endpoint)?;
    if invite.len() > 192 || RemotePeerNode::invitation_peer(&invite)? != expected_issuer {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let runtime = window.state::<RemoteRuntime>();
    let _outbound = runtime
        .outbound
        .try_lock()
        .map_err(|_| ErrorCode::Conflict)?;
    let (node, stop, _profile) = active_host(&runtime).await?;
    let routes = [route];
    tokio::select! {
        biased;
        _ = stop.cancelled() => Err(ErrorCode::Cancelled.into()),
        result = node.redeem(&routes, &invite) => result.map(|_| ()),
    }
}

#[tauri::command]
pub(crate) async fn windows_send_remote_file(
    window: WebviewWindow,
    endpoint: String,
    peer_id: PeerId,
) -> Result<Status, TransferError> {
    require_remote_origin(&window)?;
    let route = overlay_endpoint(&endpoint)?;
    let runtime = window.state::<RemoteRuntime>();
    let _outbound = runtime
        .outbound
        .try_lock()
        .map_err(|_| ErrorCode::Conflict)?;
    let (node, stop, _profile) = active_host(&runtime).await?;
    // Certificate pin and separate Remote grant come from the shared Rust core.
    let sender = node.sender(
        &[route],
        peer_id,
        Duration::from_secs(120),
        Duration::from_secs(1800),
    )?;
    let picker_window = window.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        picker_window.dialog().file().blocking_pick_file()
    })
    .await
    .map_err(|_| ErrorCode::InternalError)?
    .ok_or(ErrorCode::Cancelled)?
    .into_path()
    .map_err(|_| ErrorCode::InvalidRequest)?;
    let name = selected
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(ErrorCode::InvalidRequest)?;
    sender
        .send_resumable_file(&selected, name, stop, |_, _| {})
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<std::ffi::OsString> {
        values.iter().copied().map(Into::into).collect()
    }
    #[test]
    fn product_preference_is_protected_exact_and_fail_closed() {
        use crate::runtime::AppRuntime;
        let dir = tempfile::tempdir().unwrap();
        let protected = ProtectedFile::new(dir.path(), MODE_STORE);
        assert_eq!(read_mode(&protected).unwrap(), None);
        let native = AppRuntime::default();
        assert!(!native.nearby_enabled());
        native.configure_nearby(false);
        native.configure_nearby(true);
        assert!(!native.nearby_enabled());
        let remote = RemoteRuntime::default();
        assert!(remote.endpoint().is_err());
        protected
            .replace_write_through(br#"{"version":1,"endpoint":"100.90.1.2:48888"}"#)
            .unwrap();
        remote.configure(read_mode(&protected));
        assert_eq!(remote.endpoint().unwrap().to_string(), "100.90.1.2:48888");
        protected
            .replace_write_through(br#"{"version":1,"endpoint":null}"#)
            .unwrap();
        remote.configure(read_mode(&protected));
        assert_eq!(remote.endpoint().unwrap().to_string(), "100.90.1.2:48888");
        protected
            .replace_write_through(br#"{"version":1,"endpoint":"0.0.0.0:48888"}"#)
            .unwrap();
        let invalid = RemoteRuntime::default();
        invalid.configure(read_mode(&protected));
        assert!(invalid.mode() == LaunchMode::Unavailable);
        assert!(invalid.endpoint().is_err());
        std::fs::write(dir.path().join(MODE_STORE), b"invalid DPAPI envelope").unwrap();
        assert!(read_mode(&protected).is_err());
    }

    #[test]
    fn native_commands_only_accept_embedded_app_origin() {
        for allowed in [
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "tauri://localhost/",
        ] {
            assert!(embedded_origin(&tauri::Url::parse(allowed).unwrap()));
        }
        for denied in [
            "http://127.0.0.1:1420/",
            "http://tauri.localhost:8080/",
            "https://tauri.localhost.example/index.html",
            "http://tauri.localhost/other",
        ] {
            assert!(!embedded_origin(&tauri::Url::parse(denied).unwrap()));
        }
    }

    #[test]
    fn disabled_by_default_and_ambiguous_or_wildcard_launch_never_falls_through() {
        assert_eq!(launch_endpoint(args(&[])).unwrap(), None);
        assert_eq!(launch_endpoint(args(&["open-file.txt"])).unwrap(), None);
        assert_eq!(
            launch_endpoint(args(&[FLAG, "100.90.1.2:48888"]))
                .unwrap()
                .unwrap()
                .port(),
            48888
        );
        for denied in [
            vec![FLAG],
            vec![FLAG, "0.0.0.0:48888"],
            vec![FLAG, "100.90.1.2:0"],
            vec!["other", FLAG, "100.90.1.2:48888"],
            vec![FLAG, "100.90.1.2:48888", "other"],
        ] {
            assert!(launch_endpoint(args(&denied)).is_err());
        }
    }
}

#[path = "private_remote_folder_profile.rs"]
mod folder_profile_qualification;

#[path = "private_remote_folder_mode.rs"]
pub(crate) mod folder_mode;
