//! Optional Windows Private Remote folder lane. Explicitly enabled per session.
use super::*;
use aerift_peers::RemoteFolderIngress;
use aerift_transfer::{
    ambient::{freeze, Candidate, CaptureContext, CaptureLimits},
    folder::{commit_windows_folder, prepare_folder, WindowsFolderDirectory, WindowsFolderExport},
};
use std::{collections::HashMap, path::Path};

pub(super) struct FolderMode {
    pub(super) ingress: Arc<RemoteFolderIngress>,
    envelope: WindowsFolderDirectory,
    scratch: WindowsFolderDirectory,
    ledger: WindowsFolderDirectory,
    approved: Mutex<HashMap<TransferKey, WindowsFolderDirectory>>,
    published: Mutex<HashMap<TransferKey, String>>,
    picker: Mutex<()>,
}

impl FolderMode {
    pub(super) fn open(root: &Path) -> Result<Self, TransferError> {
        let desktop = root.join("PrivateRemoteFolderQualification");
        let envelope = desktop.join("Envelopes");
        let scratch = desktop.join("Stage");
        let ledger = desktop.join("Receipts");
        for path in [&envelope, &scratch, &ledger] {
            std::fs::create_dir_all(path).map_err(storage_failed)?;
        }
        // User-local existing exclusive profile lock is retained by DevSession.
        // Resolve every path to held checked handles before opening ingress.
        let envelope_scope =
            WindowsFolderDirectory::from_native_selection(&envelope).map_err(storage_failed)?;
        let scratch_scope =
            WindowsFolderDirectory::from_native_selection(&scratch).map_err(storage_failed)?;
        let ledger_scope =
            WindowsFolderDirectory::from_native_selection(&ledger).map_err(storage_failed)?;
        Ok(Self {
            ingress: Arc::new(RemoteFolderIngress::new(
                &envelope,
                ReceiveLimits {
                    active_bytes: BYTES,
                    session_offers: 8,
                },
                Arc::new(folder_profile_qualification::open_locked_profile(root)),
            )?),
            envelope: envelope_scope,
            scratch: scratch_scope,
            ledger: ledger_scope,
            approved: Mutex::default(),
            published: Mutex::default(),
            picker: Mutex::default(),
        })
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum FolderAction {
    Inspect,
    PickSend { peer_id: PeerId, endpoint: String },
    Approve { peer_id: PeerId, id: Uuid },
    Decline { peer_id: PeerId, id: Uuid },
    Export { peer_id: PeerId, id: Uuid },
    Dismiss { peer_id: PeerId, id: Uuid },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderReply {
    incoming: Vec<FolderView>,
    outgoing_receipt: Option<Status>,
    different_destination_volume: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderView {
    peer_id: PeerId,
    id: Uuid,
    title: String,
    entries: u32,
    size_bytes: u64,
    status: Status,
    destination_retained: bool,
    published_title: Option<String>,
}

#[tauri::command]
pub(crate) async fn windows_remote_folder_command(
    window: WebviewWindow,
    action: FolderAction,
) -> Result<FolderReply, TransferError> {
    require_remote_origin(&window)?;
    let runtime = window.state::<RemoteRuntime>();
    let (node, mode, stop, _profile) = {
        let session = runtime.session.lock().await;
        let session = session
            .as_ref()
            .filter(|session| !session.task.is_finished())
            .ok_or(ErrorCode::PeerUnavailable)?;
        let mode = session
            .folders
            .as_ref()
            .ok_or(ErrorCode::UnsupportedVersion)?;
        (
            session.node.clone(),
            mode.clone(),
            session.stop.child_token(),
            session.profile.clone(),
        )
    };
    let mut result = FolderReply {
        incoming: Vec::new(),
        outgoing_receipt: None,
        different_destination_volume: false,
    };
    match action {
        FolderAction::Inspect => {}
        FolderAction::PickSend { peer_id, endpoint } => {
            let _outbound = runtime
                .outbound
                .try_lock()
                .map_err(|_| ErrorCode::Conflict)?;
            let endpoint = overlay_endpoint(&endpoint)?;
            if !node.trusted_devices().iter().any(|peer| peer.id == peer_id) {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            let _picker = mode.picker.try_lock().map_err(|_| ErrorCode::Conflict)?;
            let path = choose_folder(window.clone()).await?;
            let preparing = stop.clone();
            let folder = tauri::async_runtime::spawn_blocking(move || {
                let capture = freeze(
                    CaptureContext {
                        explicit_selection: vec![Candidate::path(path)],
                        ..Default::default()
                    },
                    CaptureLimits {
                        total_bytes: BYTES,
                        ..CaptureLimits::default()
                    },
                )
                .map_err(|_| ErrorCode::InvalidRequest)?;
                prepare_folder(Arc::new(capture), &preparing)
            })
            .await
            .map_err(|_| ErrorCode::InternalError)??;
            result.outgoing_receipt = Some(
                node.send_folder(
                    &[endpoint],
                    peer_id,
                    &folder,
                    Uuid::new_v4(),
                    stop,
                    |_, _| {},
                )
                .await?,
            );
        }
        FolderAction::Approve { peer_id, id } => {
            let key = TransferKey { peer: peer_id, id };
            let _picker = mode.picker.try_lock().map_err(|_| ErrorCode::Conflict)?;
            let (original, receipt) = mode.ingress.review(key)?;
            if receipt.status.state != State::Pending {
                return Err(ErrorCode::Conflict.into());
            }
            let first = original.commitment();
            let selected = choose_folder(window.clone()).await?;
            let preflight_mode = mode.clone();
            let (pinned, same_volume) = tauri::async_runtime::spawn_blocking(move || {
                let pinned = WindowsFolderDirectory::from_native_selection(&selected)
                    .map_err(storage_failed)?;
                let same_volume = preflight_mode
                    .scratch
                    .shares_atomic_publish_volume(&pinned)
                    .map_err(storage_failed)?;
                Ok::<_, TransferError>((pinned, same_volume))
            })
            .await
            .map_err(|_| ErrorCode::InternalError)??;
            let (current, receipt) = mode.ingress.review(key)?;
            if stop.is_cancelled()
                || current.commitment() != first
                || receipt.status.state != State::Pending
            {
                return Err(ErrorCode::Cancelled.into());
            }
            if !same_volume {
                // No retained lease, no approval, and no requested bytes.
                result.different_destination_volume = true;
                return Ok(result);
            }
            let mut approved = mode.approved.lock().await;
            if stop.is_cancelled() {
                return Err(ErrorCode::Cancelled.into());
            }
            // The user has reviewed the offer and chosen an exact native
            // authority. No default, transmitted, webview or ambient path.
            mode.ingress.respond(key, true)?;
            approved.insert(key, pinned);
        }
        FolderAction::Decline { peer_id, id } => {
            let key = TransferKey { peer: peer_id, id };
            mode.ingress.respond(key, false)?;
            mode.approved.lock().await.remove(&key);
            mode.ingress.retire(key)?;
        }
        FolderAction::Dismiss { peer_id, id } => {
            let key = TransferKey { peer: peer_id, id };
            mode.ingress.retire(key)?;
            mode.approved.lock().await.remove(&key);
            mode.published.lock().await.remove(&key);
        }
        FolderAction::Export { peer_id, id } => {
            let key = TransferKey { peer: peer_id, id };
            let mut approved = mode.approved.lock().await;
            let (_, receipt) = mode.ingress.review(key)?;
            if receipt.status.state != State::Completed {
                return Err(ErrorCode::Conflict.into());
            }
            let destination = approved.remove(&key).ok_or(ErrorCode::PeerUnavailable)?;
            drop(approved);
            let mode_for_worker = mode.clone();
            let published = tauri::async_runtime::spawn_blocking(move || {
                let mode = &mode_for_worker;
                mode.ingress.with_completed(key, |typed, receipt, grant| {
                    let leaf = receipt
                        .saved_path
                        .as_ref()
                        .and_then(|saved| saved.file_name())
                        .and_then(|name| name.to_str())
                        .ok_or(ErrorCode::StorageFailed)?;
                    let envelope = mode
                        .envelope
                        .open_verified_envelope(leaf)
                        .map_err(storage_failed)?;
                    commit_windows_folder(
                        receipt,
                        typed,
                        WindowsFolderExport {
                            verified_envelope: envelope,
                            selected_destination: destination,
                            private_scratch: mode.scratch.try_clone().map_err(storage_failed)?,
                            private_ledger: mode.ledger.try_clone().map_err(storage_failed)?,
                        },
                        || !stop.is_cancelled() && !grant.is_cancelled(),
                    )
                })
            })
            .await
            .map_err(|_| ErrorCode::InternalError)??;
            mode.published.lock().await.insert(key, published);
        }
    }
    let mut approved = mode.approved.lock().await;
    approved.retain(|key, _| {
        mode.ingress.review(*key).is_ok_and(|(_, transfer)| {
            !matches!(
                transfer.status.state,
                State::Failed | State::Cancelled | State::Rejected
            )
        })
    });
    let published = mode.published.lock().await;
    result.incoming = mode
        .ingress
        .snapshot()
        .into_iter()
        .filter_map(|offer| {
            let (typed, _) = mode.ingress.review(offer.key).ok()?;
            Some(FolderView {
                peer_id: offer.key.peer,
                id: offer.key.id,
                title: typed.root_title().to_owned(),
                entries: typed.entries(),
                size_bytes: typed.envelope().size_bytes,
                status: offer.status,
                destination_retained: approved.contains_key(&offer.key),
                published_title: published.get(&offer.key).cloned(),
            })
        })
        .collect();
    Ok(result)
}

async fn choose_folder(window: WebviewWindow) -> Result<PathBuf, TransferError> {
    tauri::async_runtime::spawn_blocking(move || window.dialog().file().blocking_pick_folder())
        .await
        .map_err(|_| ErrorCode::InternalError)?
        .ok_or(ErrorCode::Cancelled)?
        .into_path()
        .map_err(|_| ErrorCode::InvalidRequest.into())
}
