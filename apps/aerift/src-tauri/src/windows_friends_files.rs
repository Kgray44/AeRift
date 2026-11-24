use crate::windows_friends::{host, Host};
use crate::windows_friends_member::existing_member;
use aerift_peers::{FriendBook, FriendDecision, FriendFileRoute, FriendFileWindow};
use aerift_transfer::{ErrorCode, PeerId, Status, TransferError};
use serde::{Deserialize, Serialize};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[derive(Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Profile {
    #[default]
    Primary,
    Delegated,
}

#[derive(Clone)]
pub(crate) struct MountedWindow {
    profile: Profile,
    book: Arc<FriendBook>,
    files: Arc<FriendFileWindow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Contact {
    id: String,
    devices: Vec<PeerId>,
}
fn roster(book: &FriendBook) -> Result<Vec<Contact>, TransferError> {
    Ok(book
        .contacts()?
        .into_iter()
        .map(|f| Contact {
            id: f.person.to_string(),
            devices: f.devices,
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileView {
    endpoint: Option<(SocketAddr, SocketAddr, u64)>,
    incoming: Vec<OfferView>,
    outgoing: Option<(Uuid, usize, Option<PeerId>)>,
    profile: Option<Profile>,
    can_release: bool,
    member_roster: Vec<Contact>,
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

async fn current(h: &Host) -> Result<MountedWindow, TransferError> {
    h.files
        .lock()
        .await
        .as_ref()
        .filter(|mounted| mounted.files.is_open())
        .cloned()
        .ok_or_else(|| ErrorCode::Cancelled.into())
}
#[tauri::command]
pub(crate) async fn friends_files_view(window: WebviewWindow) -> Result<FileView, TransferError> {
    let h = host(&window).await?;
    let member_roster = match existing_member(&window).await {
        Ok(Some(book)) => roster(&book)?,
        // Keep existing primary transfers usable if the optional profile is inaccessible.
        _ => vec![],
    };
    let Ok(mounted) = current(&h).await else {
        return Ok(FileView {
            endpoint: None,
            incoming: vec![],
            outgoing: None,
            receipts: vec![],
            member_roster,
            profile: None,
            can_release: false,
        });
    };
    let files = mounted.files;
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
    let outgoing = files.outgoing_person()?;
    let can_release = match outgoing.as_ref() {
        Some((id, _, Some(_))) => files.can_release(*id)?,
        _ => false,
    };
    Ok(FileView {
        endpoint: Some((route.offers, route.payload, files.expires_at())),
        incoming,
        outgoing,
        can_release,
        member_roster,
        profile: Some(mounted.profile),
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
        #[serde(default)]
        profile: Profile,
    },
    Close,
    Offer {
        friend_id: String,
        device: PeerId,
        offer_route: SocketAddr,
        payload_route: SocketAddr,
    },
    OfferPerson {
        friend_id: String,
        routes: Vec<RouteInput>,
    },
    Reconcile {
        id: Uuid,
        issuer: PeerId,
        offer_route: SocketAddr,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RouteInput {
    device: PeerId,
    offer_route: SocketAddr,
    payload_route: SocketAddr,
}

async fn selected_path(window: WebviewWindow) -> Result<std::path::PathBuf, TransferError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_, TransferError> {
        let choice = window
            .dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_file()
            .ok_or(ErrorCode::Cancelled)?;
        choice
            .into_path()
            .map_err(|_| ErrorCode::InvalidRequest.into())
    })
    .await
    .map_err(|_| ErrorCode::InternalError)?
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
        FilesAction::Open { address, profile } => {
            let (book, destination) = match profile {
                Profile::Primary => (h.book.clone(), h.received.clone()),
                Profile::Delegated => {
                    let book = existing_member(&window)
                        .await?
                        .ok_or(ErrorCode::PeerUntrusted)?;
                    if book.contacts()?.len() != 1 {
                        return Err(ErrorCode::PeerUntrusted.into());
                    }
                    (book, h.received.with_file_name("FriendsMemberReceived"))
                }
            };
            let mut slot = h.files.lock().await;
            if slot.as_ref().is_some_and(|mounted| mounted.files.is_open()) {
                return Err(ErrorCode::Conflict.into());
            }
            std::fs::create_dir_all(&destination).map_err(|_| ErrorCode::StorageFailed)?;
            let files = Arc::new(
                FriendFileWindow::open(h.identity.clone(), book.clone(), &destination, address)
                    .await?,
            );
            *slot = Some(MountedWindow {
                profile,
                book,
                files,
            });
        }
        FilesAction::Close => {
            if let Some(mounted) = h.files.lock().await.take() {
                mounted.files.stop();
            }
        }
        FilesAction::Offer {
            friend_id,
            device,
            offer_route,
            payload_route,
        } => {
            let mounted = current(&h).await?;
            let person = mounted.book.contact_id(&friend_id)?;
            let routes = FriendFileRoute::new(offer_route, payload_route)?;
            if !mounted
                .book
                .contacts()?
                .iter()
                .any(|c| c.person == person && c.devices.contains(&device))
            {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            mounted
                .files
                .offer(person, device, selected_path(window).await?, routes)
                .await?;
        }
        FilesAction::OfferPerson { friend_id, routes } => {
            let mounted = current(&h).await?;
            // Delegated member scope only targets the one pinned original device.
            if mounted.profile != Profile::Primary || routes.len() < 2 || routes.len() > 32 {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            let person = mounted.book.contact_id(&friend_id)?;
            let valid = mounted
                .book
                .contacts()?
                .into_iter()
                .find(|c| c.person == person)
                .ok_or(ErrorCode::PeerUntrusted)?;
            let mut devices = std::collections::HashSet::new();
            let mut checked = Vec::new();
            for row in routes {
                if !valid.devices.contains(&row.device) || !devices.insert(row.device) {
                    return Err(ErrorCode::PeerUntrusted.into());
                }
                checked.push((
                    row.device,
                    FriendFileRoute::new(row.offer_route, row.payload_route)?,
                ));
            }
            mounted
                .files
                .offer_person(person, selected_path(window).await?, &checked)
                .await?;
        }
        FilesAction::Reconcile {
            id,
            issuer,
            offer_route,
        } => {
            current(&h)
                .await?
                .files
                .reconcile(issuer, id, offer_route)
                .await?;
        }
        FilesAction::Accept {
            id,
            issuer,
            offer_route,
        } => {
            current(&h)
                .await?
                .files
                .accept(issuer, id, offer_route)
                .await?
        }
        FilesAction::Decline { id, issuer } => current(&h).await?.files.decline(issuer, id).await?,
        FilesAction::Send { id } => return Ok(Some(current(&h).await?.files.send(id).await?)),
        FilesAction::Withdraw { id } => current(&h).await?.files.withdraw(id).await?,
    }
    Ok(None)
}
