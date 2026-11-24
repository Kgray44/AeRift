//! This dedicated developer runtime never registers the ordinary AeRift
//! Nearby dispatcher, camera, clipboard, Explorer hooks, or readiness command.
use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use aerift_peers::{Device, Platform, RemotePeerNode};
use aerift_transfer::{
    ErrorCode, PeerId, ReceiveLimits, State, Status, TransferError, TransferKey,
};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::private_remote_profile::{overlay_endpoint, PrivateRemoteProfile};

const FLAG: &str = "--private-remote-dev";
const BYTES: u64 = 256 * 1024 * 1024;

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

pub(crate) fn run(endpoint: SocketAddr, mut context: tauri::Context<Wry>) {
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    tauri::Builder::default()
        .manage(DevRuntime { endpoint, session: Mutex::new(None) })
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

struct DevRuntime {
    endpoint: SocketAddr,
    session: Mutex<Option<Arc<DevSession>>>,
}

struct DevSession {
    node: Arc<RemotePeerNode>,
    stop: CancellationToken,
    task: JoinHandle<Result<(), TransferError>>,
    _profile: std::fs::File,
}

impl Drop for DevSession {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    active: bool,
    endpoint: String,
    identity: Option<PeerId>,
    peers: Vec<Device>,
    pairing: Option<Pending>,
    offers: Vec<OfferView>,
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
enum Action {
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
struct ActionResult {
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

fn require_developer_window(window: &WebviewWindow) -> Result<(), TransferError> {
    if window.label() != "main" || !window.url().is_ok_and(|url| embedded_origin(&url)) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(())
}

#[tauri::command]
async fn private_remote_snapshot(window: WebviewWindow) -> Result<Snapshot, TransferError> {
    require_developer_window(&window)?;
    let runtime = window.state::<DevRuntime>();
    let session = runtime.session.lock().await;
    let mut result = Snapshot {
        active: false,
        endpoint: runtime.endpoint.to_string(),
        identity: None,
        peers: Vec::new(),
        pairing: None,
        offers: Vec::new(),
    };
    let Some(session) = session
        .as_ref()
        .filter(|session| !session.task.is_finished())
    else {
        return Ok(result);
    };
    result.active = true;
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
) -> Result<(Arc<RemotePeerNode>, std::fs::File), TransferError> {
    std::fs::create_dir_all(&root).map_err(|_| ErrorCode::StorageFailed)?;
    let profile = PrivateRemoteProfile::open(&root)?;
    let received = root.join("RemoteQualificationReceived");
    std::fs::create_dir_all(&received).map_err(|_| ErrorCode::StorageFailed)?;
    let (identity, trust, lock) = profile.into_host_parts()?;
    let node = RemotePeerNode::new(
        identity,
        "AeRift Windows Private Remote".into(),
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
async fn private_remote_start(window: WebviewWindow, confirmed: bool) -> Result<(), TransferError> {
    require_developer_window(&window)?;
    if !confirmed {
        return Err(ErrorCode::Cancelled.into());
    }
    let runtime = window.state::<DevRuntime>();
    let mut slot = runtime.session.lock().await;
    if slot.is_some() {
        return Err(ErrorCode::Conflict.into());
    }
    let root = window
        .path()
        .app_local_data_dir()
        .map_err(|_| ErrorCode::StorageFailed)?;
    let (node, lock) = tauri::async_runtime::spawn_blocking(move || initialize_profile(root))
        .await
        .map_err(|_| ErrorCode::InternalError)??;
    // The webview cannot choose or change this immutable launch address. It
    // came from the literal, validated private endpoint and has no wildcard.
    let listener = TcpListener::bind(runtime.endpoint)
        .await
        .map_err(|_| ErrorCode::NetworkError)?;
    let stop = CancellationToken::new();
    let task = tokio::spawn({
        let (node, stop) = (node.clone(), stop.clone());
        async move { node.serve(listener, stop).await }
    });
    *slot = Some(Arc::new(DevSession {
        node,
        stop,
        task,
        _profile: lock,
    }));
    Ok(())
}

#[tauri::command]
async fn private_remote_action(
    window: WebviewWindow,
    request: Action,
) -> Result<ActionResult, TransferError> {
    require_developer_window(&window)?;
    let runtime = window.state::<DevRuntime>();
    let mut slot = runtime.session.lock().await;
    let mut reply = ActionResult { invite: None };
    if matches!(request, Action::Stop) {
        let Some(session) = slot.take() else {
            return Ok(reply);
        };
        let mut session = Arc::try_unwrap(session).map_err(|_| ErrorCode::Conflict)?;
        session.stop.cancel();
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

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<std::ffi::OsString> {
        values.iter().copied().map(Into::into).collect()
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
