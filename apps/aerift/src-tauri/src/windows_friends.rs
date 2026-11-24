//! Normal Windows Friends setup. No discovery, no global directory, no automatic listening.
use crate::{
    runtime::AppRuntime,
    windows_storage::{open_friends, storage_failed, WindowsIdentity},
};
use aerift_peers::{
    FriendAuthority, FriendBook, FriendInvitation, FriendInviteEndpoint, FriendInviteState,
    Identity, PersonId,
};
use aerift_transfer::{ErrorCode, TransferError};
use serde::{Deserialize, Serialize};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tokio::{
    net::TcpListener,
    sync::{Mutex, OnceCell},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
pub(crate) struct WindowsFriends(OnceCell<Arc<Host>>);
pub(crate) struct Host {
    pub(crate) identity: Arc<Identity>,
    authority: FriendAuthority,
    pub(crate) book: Arc<FriendBook>,
    pub(crate) files: Mutex<Option<Arc<aerift_peers::FriendFileWindow>>>,
    pub(crate) received: std::path::PathBuf,
    active: Mutex<Option<(FriendInvitation, CancellationToken)>>,
}
impl Drop for Host {
    fn drop(&mut self) {
        if let Some((_, stop)) = self.active.get_mut().take() {
            stop.cancel();
        }
    }
}

fn now() -> Result<u64, TransferError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ErrorCode::InternalError)?
        .as_secs())
}

fn private_ip(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    ip.is_private() || ip.is_loopback() || (a == 100 && (64..=127).contains(&b))
}

pub(crate) async fn host(window: &tauri::WebviewWindow) -> Result<Arc<Host>, TransferError> {
    if window.label() != "main" {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let root = window.path().app_local_data_dir().map_err(storage_failed)?;
    // Acquire the product profile lock before opening any protected data.
    window.state::<AppRuntime>().session(root.clone()).await?;
    let state = window.state::<WindowsFriends>();
    state
        .0
        .get_or_try_init(|| async move {
            tauri::async_runtime::spawn_blocking(move || {
                let identity = Arc::new(Identity::load_or_create(&WindowsIdentity::new(&root))?);
                let (authority, book) = open_friends(&root)?;
                Ok::<_, TransferError>(Arc::new(Host {
                    identity,
                    authority,
                    book,
                    active: Mutex::new(None),
                    files: Mutex::new(None),
                    received: root.join("FriendsReceived"),
                }))
            })
            .await
            .map_err(|_| ErrorCode::InternalError)?
        })
        .await
        .map(Arc::clone)
}

/// Transport hint carried privately with a signed invitation. A modified hint never
/// changes the mTLS pin. Only bounded numeric LAN/VPN addresses may be dialed.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    route: SocketAddr,
    invite: FriendInvitation,
    signature: String,
}

fn envelope(value: &str) -> Result<Envelope, TransferError> {
    if value.len() > 4096 {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let e: Envelope = serde_json::from_str(value).map_err(|_| ErrorCode::InvalidRequest)?;
    if !matches!(e.route, SocketAddr::V4(v) if private_ip(*v.ip()) && v.port() != 0) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    e.invite.verify_route(e.route, &e.signature)?;
    Ok(e)
}
fn brief(person: PersonId) -> String {
    format!("Friend {}", &person.to_string()[..12])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct View {
    profile: String,
    contacts: Vec<Contact>,
    pending_recipient: Option<Review>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Contact {
    id: String,
    label: String,
    verification: String,
    incoming_allowed: bool,
    devices: Vec<Device>,
}
#[derive(Serialize)]
struct Device {
    id: String,
    label: String,
    availability: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Review {
    id: Uuid,
    verification: String,
    expires_at: u64,
}
fn review(invite: &FriendInvitation, person: PersonId) -> Review {
    Review {
        id: invite.id(),
        verification: person.to_string(),
        expires_at: invite.expires_at(),
    }
}

#[tauri::command]
pub(crate) async fn friends_setup_view(
    window: tauri::WebviewWindow,
) -> Result<View, TransferError> {
    let h = host(&window).await?;
    let time = now()?;
    let active = h.active.lock().await;
    let pending_recipient = active.as_ref().and_then(|(invite, _)| {
        matches!(
            FriendInviteEndpoint::local_state(&h.identity, &h.book, invite.id(), time),
            Ok(FriendInviteState::RecipientConsented)
        )
        .then(|| review(invite, invite.recipient()))
    });
    let contacts = h
        .book
        .contacts()?
        .into_iter()
        .map(|f| Contact {
            id: f.person.to_string(),
            label: brief(f.person),
            verification: f.person.to_string(),
            incoming_allowed: f.receive_allowed,
            devices: f
                .devices
                .into_iter()
                .map(|id| Device {
                    id: id.to_string(),
                    label: format!("Device {}", &id.to_string()[..12]),
                    availability: "unknown",
                })
                .collect(),
        })
        .collect();
    Ok(View {
        profile: h.authority.id().to_string(),
        contacts,
        pending_recipient,
    })
}

#[tauri::command]
pub(crate) async fn friends_setup_card(
    window: tauri::WebviewWindow,
) -> Result<String, TransferError> {
    let h = host(&window).await?;
    h.authority.contact_card(h.identity.id(), now()?)
}

#[tauri::command]
pub(crate) async fn friends_setup_issue(
    window: tauri::WebviewWindow,
    bind_address: String,
    recipient_card: String,
) -> Result<String, TransferError> {
    let h = host(&window).await?;
    let ip: Ipv4Addr = bind_address
        .parse()
        .map_err(|_| ErrorCode::InvalidRequest)?;
    if !private_ip(ip) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let mut active = h.active.lock().await;
    let time = now()?;
    if let Some((old, stop)) = active.as_ref() {
        if old.expires_at() > time {
            return Err(ErrorCode::Conflict.into());
        }
        stop.cancel();
    }
    let listener = TcpListener::bind((ip, 0))
        .await
        .map_err(|_| ErrorCode::NetworkError)?;
    let route = listener.local_addr().map_err(|_| ErrorCode::NetworkError)?;
    let invite =
        FriendInviteEndpoint::issue(&h.authority, &h.identity, &h.book, &recipient_card, time)?;
    let signature = h.authority.sign_route(&invite, route)?;
    let duration = std::time::Duration::from_secs(invite.expires_at().saturating_sub(time));
    let stop = CancellationToken::new();
    *active = Some((invite.clone(), stop.clone()));
    let identity = h.identity.clone();
    let book = Arc::clone(&h.book);
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = FriendInviteEndpoint::serve(&identity, listener, book, stop.clone()) => {},
            _ = tokio::time::sleep(duration) => { stop.cancel(); },
        }
    });
    serde_json::to_string(&Envelope {
        route,
        invite,
        signature,
    })
    .map_err(|_| ErrorCode::InternalError.into())
}

#[tauri::command]
pub(crate) async fn friends_setup_review(
    window: tauri::WebviewWindow,
    invitation: String,
) -> Result<Review, TransferError> {
    let h = host(&window).await?;
    let e = envelope(&invitation)?;
    let person = e.invite.review(h.authority.id(), h.identity.id(), now()?)?;
    Ok(review(&e.invite, person))
}

#[tauri::command]
pub(crate) async fn friends_setup_consent(
    window: tauri::WebviewWindow,
    invitation: String,
) -> Result<(), TransferError> {
    let h = host(&window).await?;
    let e = envelope(&invitation)?;
    FriendInviteEndpoint::consent(
        &h.authority,
        &h.identity,
        &h.book,
        &[e.route],
        &e.invite,
        now()?,
    )
    .await
}

#[tauri::command]
pub(crate) async fn friends_setup_finish(
    window: tauri::WebviewWindow,
    invitation: String,
) -> Result<bool, TransferError> {
    let h = host(&window).await?;
    let e = envelope(&invitation)?;
    FriendInviteEndpoint::finish(
        &h.authority,
        &h.identity,
        &h.book,
        &[e.route],
        &e.invite,
        now()?,
    )
    .await
}

#[tauri::command]
pub(crate) async fn friends_setup_answer(
    window: tauri::WebviewWindow,
    id: Uuid,
    accept: bool,
) -> Result<(), TransferError> {
    let h = host(&window).await?;
    let mut active = h.active.lock().await;
    let (invite, stop) = active
        .as_ref()
        .filter(|(invite, _)| invite.id() == id)
        .ok_or(ErrorCode::PairingRejected)?;
    if accept {
        FriendInviteEndpoint::approve(&h.authority, &h.identity, &h.book, invite.id(), now()?)
    } else {
        FriendInviteEndpoint::decline(&h.book, invite.id())?;
        stop.cancel();
        *active = None;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum ContactAction {
    RemoveFriend {
        #[serde(rename = "friendId")]
        friend_id: String,
    },
    RevokeDevice {
        #[serde(rename = "friendId")]
        friend_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    SetPermissions {
        #[serde(rename = "friendId")]
        friend_id: String,
        #[serde(rename = "allowIncoming")]
        allow_incoming: bool,
    },
}
#[tauri::command]
pub(crate) async fn friends_setup_contact(
    window: tauri::WebviewWindow,
    request: ContactAction,
) -> Result<(), TransferError> {
    let h = host(&window).await?;
    let book = &h.book;
    match request {
        ContactAction::RemoveFriend { friend_id } => book.remove(book.contact_id(&friend_id)?),
        ContactAction::RevokeDevice {
            friend_id,
            device_id,
        } => book.revoke_device(
            book.contact_id(&friend_id)?,
            device_id.parse().map_err(|_| ErrorCode::InvalidRequest)?,
        ),
        ContactAction::SetPermissions {
            friend_id,
            allow_incoming,
        } => book.set_receive_permission(book.contact_id(&friend_id)?, allow_incoming),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn setup_refuses_public_and_nonunicast_bind_addresses() {
        for ip in [
            "0.0.0.0",
            "8.8.8.8",
            "224.0.0.1",
            "255.255.255.255",
            "100.63.0.1",
            "100.128.0.1",
        ] {
            assert!(!private_ip(ip.parse().unwrap()));
        }
        for ip in [
            "10.1.0.2",
            "192.168.1.2",
            "172.16.0.1",
            "127.0.0.1",
            "100.64.0.1",
            "100.127.0.1",
        ] {
            assert!(private_ip(ip.parse().unwrap()));
        }
    }
}
