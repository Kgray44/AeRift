//! Explicit enrollment ceremony in the normal Windows host. All handoffs are
//! private; IPC renders a verified preview, then consumes a native review ID.
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use aerift_peers::{
    DelegatedFriendMember, DelegatedReview, DelegatedRoute, FriendBook, FriendInviteEndpoint,
};
use aerift_transfer::{ErrorCode, PeerId, TransferError};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};
use tokio::{net::TcpListener, sync::Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    windows_friends::{host, now, private_ip},
    windows_storage::{join_friends_member, open_friends_member, storage_failed},
};

#[derive(Default)]
pub(crate) struct MemberRuntime(Mutex<Progress>);

#[derive(Default)]
struct Progress {
    active: Option<(CancellationToken, u64)>,
    book: Option<Arc<FriendBook>>,
}
impl Drop for Progress {
    fn drop(&mut self) {
        if let Some((stop, _)) = self.active.take() {
            stop.cancel();
        }
    }
}

enum Pending {
    Issue {
        friend: String,
        relationship: Uuid,
        device: PeerId,
    },
    Approve {
        member: DelegatedFriendMember,
        device: PeerId,
    },
    Join(DelegatedRoute),
}
impl Pending {
    fn belongs_to(&self, action: Action) -> bool {
        matches!(
            (self, action),
            (Self::Issue { .. }, Action::Issue)
                | (Self::Approve { .. }, Action::Approve)
                | (Self::Join(_), Action::Join)
        )
    }
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Action {
    Issue,
    Approve,
    Join,
}

// Separate timestamp/id wrapper, not information supplied by the renderer.
struct ReviewSlot {
    id: Uuid,
    deadline: u64,
    step: Pending,
}
#[derive(Default)]
pub(crate) struct ReviewRuntime(Mutex<Option<ReviewSlot>>);

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    View,
    ReviewIssue {
        friend_id: String,
        device: PeerId,
    },
    ReviewApproval {
        capsule: String,
        device: PeerId,
    },
    ReviewJoin {
        approval: String,
    },
    Confirm {
        review_id: Uuid,
        operation: Action,
        address: Option<Ipv4Addr>,
    },
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Response {
    View {
        local_device: PeerId,
        member_contacts: usize,
    },
    Review {
        review_id: Uuid,
        owner: String,
        friend: String,
        device: PeerId,
        friend_device: Option<PeerId>,
        expires_at: u64,
        route: Option<SocketAddr>,
    },
    Handoff {
        text: String,
    },
    Joined,
}

fn decode<T: for<'a> Deserialize<'a>>(value: &str) -> Result<T, TransferError> {
    if value.len() > 4096 {
        return Err(ErrorCode::InvalidRequest.into());
    }
    serde_json::from_str(value).map_err(|_| ErrorCode::InvalidRequest.into())
}
fn handoff<T: Serialize>(value: &T) -> Result<Response, TransferError> {
    let text = serde_json::to_string(value).map_err(|_| ErrorCode::InternalError)?;
    if text.len() > 4096 {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(Response::Handoff { text })
}
fn describe(review_id: Uuid, review: DelegatedReview, route: Option<SocketAddr>) -> Response {
    Response::Review {
        review_id,
        owner: review.owner.to_string(),
        friend: review.friend.to_string(),
        device: review.device,
        friend_device: Some(review.friend_device),
        expires_at: review.expires_at,
        route,
    }
}

fn take_review(
    pending: &mut Option<ReviewSlot>,
    review_id: Uuid,
    operation: Action,
    current: u64,
) -> Result<Pending, TransferError> {
    if pending
        .as_ref()
        .is_none_or(|p| p.id != review_id || current >= p.deadline || !p.step.belongs_to(operation))
    {
        return Err(ErrorCode::PairingRejected.into());
    }
    Ok(pending.take().ok_or(ErrorCode::PairingRejected)?.step)
}

pub(crate) async fn existing_member(
    window: &WebviewWindow,
) -> Result<Option<Arc<FriendBook>>, TransferError> {
    let h = host(window).await?;
    let root = window.path().app_local_data_dir().map_err(storage_failed)?;
    let runtime = window.state::<MemberRuntime>();
    let mut state = runtime.0.lock().await;
    if state.book.is_none() && root.join("friends-member-v1/book.dpapi").is_file() {
        state.book = Some(open_friends_member(&root, &h.identity)?);
    }
    Ok(state.book.clone())
}

#[tauri::command]
pub(crate) async fn friends_member(
    window: WebviewWindow,
    request: Request,
) -> Result<Response, TransferError> {
    let h = host(&window).await?;
    let root = window.path().app_local_data_dir().map_err(storage_failed)?;
    let member_runtime = window.state::<MemberRuntime>();
    let reviews = window.state::<ReviewRuntime>();
    let current = now()?;
    match request {
        Request::View => {
            let mut state = member_runtime.0.lock().await;
            if state.book.is_none() && root.join("friends-member-v1/book.dpapi").is_file() {
                state.book = Some(open_friends_member(&root, &h.identity)?);
            }
            let member_contacts = match &state.book {
                Some(book) => book.contacts()?.len(),
                None => 0,
            };
            Ok(Response::View {
                local_device: h.identity.id(),
                member_contacts,
            })
        }
        Request::ReviewIssue { friend_id, device } => {
            if device == h.identity.id() {
                return Err(ErrorCode::InvalidRequest.into());
            }
            let friend = h.book.contact_id(&friend_id)?;
            let relationship = h.book.delegation_candidate(friend, device)?;
            let id = Uuid::new_v4();
            let deadline = current + 120;
            *reviews.0.lock().await = Some(ReviewSlot {
                id,
                deadline,
                step: Pending::Issue {
                    friend: friend_id,
                    relationship,
                    device,
                },
            });
            Ok(Response::Review {
                review_id: id,
                owner: h.authority.id().to_string(),
                friend: friend.to_string(),
                device,
                friend_device: None,
                expires_at: deadline,
                route: None,
            })
        }
        Request::ReviewApproval { capsule, device } => {
            let member: DelegatedFriendMember = decode(&capsule)?;
            let review = member.review(device, current)?;
            if review.friend != h.authority.id()
                || review.friend_device != h.identity.id()
                || h.book.delegation_candidate(review.owner, device)? != review.relationship
            {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            let id = Uuid::new_v4();
            *reviews.0.lock().await = Some(ReviewSlot {
                id,
                deadline: review.expires_at,
                step: Pending::Approve { member, device },
            });
            Ok(describe(id, review, None))
        }
        Request::ReviewJoin { approval } => {
            let wire: DelegatedRoute = decode(&approval)?;
            let review = wire.review(h.identity.id(), current)?;
            let id = Uuid::new_v4();
            let route = wire.route();
            *reviews.0.lock().await = Some(ReviewSlot {
                id,
                deadline: review.expires_at,
                step: Pending::Join(wire),
            });
            Ok(describe(id, review, Some(route)))
        }
        Request::Confirm {
            review_id,
            operation,
            address,
        } => {
            let reviewed = {
                let mut pending = reviews.0.lock().await;
                take_review(&mut pending, review_id, operation, current)?
            };
            match reviewed {
                Pending::Issue {
                    friend,
                    device,
                    relationship,
                } => {
                    let friend = h.book.contact_id(&friend)?;
                    let capsule = h
                        .book
                        .delegate_contact(&h.authority, friend, device, current)?;
                    if capsule.review(device, current)?.relationship != relationship {
                        return Err(ErrorCode::PairingRejected.into());
                    }
                    handoff(&capsule)
                }
                Pending::Approve { member, device } => {
                    let ip = address
                        .filter(|ip| private_ip(*ip))
                        .ok_or(ErrorCode::InvalidRequest)?;
                    let mut state = member_runtime.0.lock().await;
                    if state
                        .active
                        .as_ref()
                        .is_some_and(|(stop, until)| !stop.is_cancelled() && current < *until)
                    {
                        return Err(ErrorCode::Conflict.into());
                    }
                    let listener = TcpListener::bind((ip, 0))
                        .await
                        .map_err(|_| ErrorCode::NetworkError)?;
                    let route = listener.local_addr().map_err(|_| ErrorCode::NetworkError)?;
                    let review = member.review(device, current)?;
                    let ticket = FriendInviteEndpoint::expect_delegated(
                        &h.identity,
                        &h.book,
                        &member,
                        device,
                        current,
                    )?;
                    let wire =
                        DelegatedRoute::sign(&h.authority, member, device, ticket, route, current)?;
                    let output = handoff(&wire)?;
                    let stop = CancellationToken::new();
                    state.active = Some((stop.clone(), review.expires_at));
                    let identity = h.identity.clone();
                    let book = h.book.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::select! {
                            _=FriendInviteEndpoint::serve(&identity,listener,book,stop.clone()) => {},
                            _=tokio::time::sleep(Duration::from_secs(review.expires_at.saturating_sub(current))) => {},
                        }
                        stop.cancel();
                    });
                    Ok(output)
                }
                Pending::Join(wire) => {
                    let mut state = member_runtime.0.lock().await;
                    if state.book.is_some() || root.join("friends-member-v1/book.dpapi").exists() {
                        return Err(ErrorCode::Conflict.into());
                    }
                    wire.review(h.identity.id(), current)?;
                    let (member, route, ticket) = wire.into_parts();
                    let joined =
                        join_friends_member(&root, &h.identity, member, &[route], ticket).await?;
                    state.book = Some(joined);
                    Ok(Response::Joined)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrollment_confirmation_requires_exact_unexpired_single_use_native_review() {
        let id = Uuid::new_v4();
        let mut review = Some(ReviewSlot {
            id,
            deadline: 20,
            step: Pending::Issue {
                friend: String::new(),
                relationship: Uuid::new_v4(),
                device: PeerId::from_tls_leaf(b"synthetic-test-device"),
            },
        });
        assert!(take_review(&mut review, Uuid::new_v4(), Action::Issue, 10).is_err());
        assert!(take_review(&mut review, id, Action::Join, 10).is_err());
        assert!(take_review(&mut review, id, Action::Issue, 20).is_err());
        assert!(matches!(
            take_review(&mut review, id, Action::Issue, 19),
            Ok(Pending::Issue { .. })
        ));
        assert!(take_review(&mut review, id, Action::Issue, 19).is_err());
    }
}
