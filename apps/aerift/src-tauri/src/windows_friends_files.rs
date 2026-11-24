use crate::windows_friends::{host, Host};
use aerift_peers::{FriendDecision, FriendFileRoute, FriendFileWindow};
use aerift_transfer::{ErrorCode, PeerId, Status, TransferError};
use serde::{Deserialize, Serialize};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileView {
    endpoint: Option<(SocketAddr, SocketAddr, u64)>,
    incoming: Vec<OfferView>,
    outgoing: Option<(Uuid, PeerId, bool)>,
    receipts: Vec<(PeerId, Uuid, Status)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfferView {
    id: Uuid,
    issuer: PeerId,
    sender: String,
    label: String,
    size_bytes: u64,
    accepted: bool,
}

async fn current(h: &Host) -> Result<Arc<FriendFileWindow>, TransferError> {
    h.files
        .lock()
        .await
        .as_ref()
        .filter(|files| files.is_open())
        .cloned()
        .ok_or_else(|| ErrorCode::Cancelled.into())
}
#[tauri::command]
pub(crate) async fn friends_files_view(window: WebviewWindow) -> Result<FileView, TransferError> {
    let h = host(&window).await?;
    let Ok(files) = current(&h).await else {
        return Ok(FileView {
            endpoint: None,
            incoming: vec![],
            outgoing: None,
            receipts: vec![],
        });
    };
    let route = files.route();
    let incoming = files
        .incoming()?
        .into_iter()
        .filter(|o| o.decision() != FriendDecision::Withdrawn)
        .map(|o| OfferView {
            id: o.id(),
            issuer: o.issuer(),
            sender: o.sender().to_string(),
            label: o.object().label().to_owned(),
            size_bytes: o.object().size_bytes(),
            accepted: o.decision() == FriendDecision::Granted,
        })
        .collect();
    Ok(FileView {
        endpoint: Some((route.offers, route.payload, files.expires_at())),
        incoming,
        outgoing: files.outgoing()?,
        receipts: files.receipts(),
    })
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum FilesAction {
    Open {
        address: Ipv4Addr,
    },
    Close,
    Offer {
        friend_id: String,
        device: PeerId,
        offer_route: SocketAddr,
        payload_route: SocketAddr,
    },
    Accept {
        id: Uuid,
        issuer: PeerId,
        offer_route: SocketAddr,
    },
    Decline {
        id: Uuid,
        issuer: PeerId,
    },
    Send {
        id: Uuid,
    },
    Withdraw {
        id: Uuid,
    },
}

/// Only commands in the existing normal Windows main profile can start a
/// receive window. No frontend-supplied filesystem path is ever accepted.
#[tauri::command]
pub(crate) async fn friends_files_action(
    window: WebviewWindow,
    request: FilesAction,
) -> Result<Option<Status>, TransferError> {
    let h = host(&window).await?;
    match request {
        FilesAction::Open { address } => {
            let mut slot = h.files.lock().await;
            if slot.as_ref().is_some_and(|files| files.is_open()) {
                return Err(ErrorCode::Conflict.into());
            }
            std::fs::create_dir_all(&h.received).map_err(|_| ErrorCode::StorageFailed)?;
            *slot = Some(Arc::new(
                FriendFileWindow::open(h.identity.clone(), h.book.clone(), &h.received, address)
                    .await?,
            ));
        }
        FilesAction::Close => {
            if let Some(files) = h.files.lock().await.take() {
                files.stop();
            }
        }
        FilesAction::Offer {
            friend_id,
            device,
            offer_route,
            payload_route,
        } => {
            let files = current(&h).await?;
            let person = h.book.contact_id(&friend_id)?;
            let routes = FriendFileRoute::new(offer_route, payload_route)?;
            let valid = h
                .book
                .contacts()?
                .into_iter()
                .any(|contact| contact.person == person && contact.devices.contains(&device));
            if !valid {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            let chosen =
                tauri::async_runtime::spawn_blocking(move || -> Result<_, TransferError> {
                    window
                        .dialog()
                        .file()
                        .set_parent(&window)
                        .blocking_pick_file()
                        .map(|file| {
                            file.into_path()
                                .map_err(|_| ErrorCode::InvalidRequest.into())
                        })
                        .transpose()
                })
                .await
                .map_err(|_| ErrorCode::InternalError)??;
            let Some(path) = chosen else {
                return Err(ErrorCode::Cancelled.into());
            };
            files.offer(person, device, path, routes).await?;
        }
        FilesAction::Accept {
            id,
            issuer,
            offer_route,
        } => current(&h).await?.accept(issuer, id, offer_route).await?,
        FilesAction::Decline { id, issuer } => current(&h).await?.decline(issuer, id).await?,
        FilesAction::Send { id } => return Ok(Some(current(&h).await?.send(id).await?)),
        FilesAction::Withdraw { id } => current(&h).await?.withdraw(id).await?,
    }
    Ok(None)
}
