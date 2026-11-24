//! Opt-in Nearby control route. Not installed in the generic transfer router.

use super::session::{Dispatch, DropAuthority, DropError, Frame, HeldSession, Lane};
use crate::{ErrorCode, PeerId, TransferError, ambient::FrozenCapture, read_control, server};
use bytes::Bytes;
use http_body_util::Full;
use hyper::{Method, Request, Response, StatusCode, Version, body::Incoming, header};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_PAIRED_CANDIDATES: usize = 16;
const SELECTION_WINDOW: std::time::Duration = std::time::Duration::from_secs(2);

pub const PATH: &str = "/v1/ambient/nearby-drop";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Claim {
    pub interaction: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Availability {
    pub challenge: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Recorded {
    pub recorded: bool,
}

/// Construct only from a local opt-in pickup. This service is deliberately
/// not mounted by normal Nearby, Remote, or Friends transfer routing.
pub struct NearbyDrop {
    held: Mutex<Window>,
}

struct Window {
    held: HeldSession,
    issued: HashMap<PeerId, Uuid>,
    recorded: HashSet<PeerId>,
}

impl NearbyDrop {
    pub fn open(capture: FrozenCapture, now: Instant) -> Option<Self> {
        Some(Self {
            held: Mutex::new(Window {
                held: HeldSession::pickup(capture, Lane::Nearby, now)?,
                issued: HashMap::new(),
                recorded: HashSet::new(),
            }),
        })
    }

    pub fn close(&self) {
        if let Ok(mut state) = self.held.lock() {
            state.held.revoke();
            state.issued.clear();
        }
    }

    pub fn held_frame(&self) -> Option<Frame> {
        Some(self.held.lock().ok()?.held.held_frame())
    }

    pub fn interaction(&self) -> Option<Uuid> {
        Some(self.held.lock().ok()?.held.id())
    }

    pub fn resolve(
        &self,
        now: Instant,
        authority: &impl DropAuthority,
    ) -> Result<Dispatch, DropError> {
        self.held
            .lock()
            .map_err(|_| DropError::Closed)?
            .held
            .resolve(now, authority)
    }

    /// Invoke only *after* deriving peer from the authenticated mTLS leaf of
    /// the live Nearby connection. Admission is rechecked after body reading;
    /// a ready/presence signal cannot call this function or substitute consent.
    pub async fn handle_authenticated(
        &self,
        request: Request<Incoming>,
        peer: PeerId,
        lane: Lane,
        trust: &CancellationToken,
        authority: &impl DropAuthority,
    ) -> Response<Full<Bytes>> {
        if request.method() == Method::GET {
            return Self::availability(Some(self), request, peer, lane, trust, authority);
        }
        match self.record(request, peer, lane, trust, authority).await {
            Ok(()) => {
                let mut reply = server::json(StatusCode::OK, &Recorded { recorded: true });
                reply.headers_mut().insert(
                    header::CACHE_CONTROL,
                    header::HeaderValue::from_static("no-store"),
                );
                reply
            }
            Err(error) => server::error(error),
        }
    }

    /// Hosts without an open pickup use None so the authenticated recipient
    /// can distinguish an idle peer from an unknown/incomplete query.
    pub fn availability(
        service: Option<&Self>,
        request: Request<Incoming>,
        peer: PeerId,
        lane: Lane,
        trust: &CancellationToken,
        authority: &impl DropAuthority,
    ) -> Response<Full<Bytes>> {
        use hyper::body::Body;
        let reply = (|| -> Result<Availability, TransferError> {
            if lane != Lane::Nearby || trust.is_cancelled() || !authority.permits(peer, lane) {
                return Err(ErrorCode::PeerUntrusted.into());
            }
            if request.method() != Method::GET
                || request.uri().path() != PATH
                || request.uri().query().is_some()
                || request.version() != Version::HTTP_11
                || request.body().size_hint().exact() != Some(0)
            {
                return Err(ErrorCode::InvalidRequest.into());
            }
            let challenge = if let Some(service) = service {
                let mut state = service.held.lock().map_err(|_| ErrorCode::InternalError)?;
                if !state.held.accepts_claim_at(Instant::now()) || state.recorded.contains(&peer) {
                    None
                } else if let Some(token) = state.issued.get(&peer) {
                    Some(token.to_string())
                } else if state.issued.len() >= MAX_PAIRED_CANDIDATES {
                    return Err(ErrorCode::Conflict.into());
                } else {
                    let token = Uuid::new_v4();
                    state.issued.insert(peer, token);
                    Some(token.to_string())
                }
            } else {
                None
            };
            Ok(Availability { challenge })
        })();
        match reply {
            Ok(response) => {
                let mut reply = server::json(StatusCode::OK, &response);
                reply.headers_mut().insert(
                    header::CACHE_CONTROL,
                    header::HeaderValue::from_static("no-store"),
                );
                reply
            }
            Err(error) => server::error(error),
        }
    }

    async fn record(
        &self,
        request: Request<Incoming>,
        peer: PeerId,
        lane: Lane,
        trust: &CancellationToken,
        authority: &impl DropAuthority,
    ) -> Result<(), TransferError> {
        if lane != Lane::Nearby || trust.is_cancelled() || !authority.permits(peer, lane) {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        if request.method() != Method::POST
            || request.uri().path() != PATH
            || request.uri().query().is_some()
            || request.version() != Version::HTTP_11
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let body = tokio::select! {
            biased;
            _ = trust.cancelled() => return Err(ErrorCode::PeerUntrusted.into()),
            data = tokio::time::timeout(std::time::Duration::from_secs(2), read_control(request.into_body())) =>
                data.map_err(|_| ErrorCode::NetworkError)?.map_err(|_| ErrorCode::InvalidRequest)?,
        };
        let claim: Claim = serde_json::from_slice(&body).map_err(|_| ErrorCode::InvalidRequest)?;
        let mut state = self.held.lock().map_err(|_| ErrorCode::InternalError)?;
        let Window {
            held,
            issued,
            recorded,
        } = &mut *state;
        let challenge = crate::parse_id(&claim.interaction).ok_or(ErrorCode::InvalidRequest)?;
        if recorded.len() >= 2 || recorded.contains(&peer) || issued.get(&peer) != Some(&challenge)
        {
            return Err(ErrorCode::InvalidRequest.into());
        }
        if trust.is_cancelled() {
            return Err(ErrorCode::PeerUntrusted.into());
        }
        held.drop_claim(held.id(), peer, lane, Instant::now(), authority)
            .map_err(|e| match e {
                DropError::Unauthorized => ErrorCode::PeerUntrusted,
                _ => ErrorCode::InvalidRequest,
            })?;
        issued.remove(&peer);
        recorded.insert(peer);
        Ok(())
    }
}

/// Call only on an explicit opt-in recipient gesture, with a deduplicated
/// snapshot of *currently reachable* paired Nearby connectors. The host must
/// pin each exact peer and never supply public/Remote/Friends endpoints.
pub async fn claim_only_nearby_pickup<C: crate::Connector + 'static>(
    peers: Vec<(PeerId, crate::Sender<C>)>,
    gesture: &CancellationToken,
) -> Result<(), TransferError> {
    if peers.is_empty() || peers.len() > MAX_PAIRED_CANDIDATES {
        return Err(ErrorCode::PeerUnavailable.into());
    }
    let identities: HashSet<_> = peers.iter().map(|(peer, _)| *peer).collect();
    if identities.len() != peers.len() {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let deadline = tokio::time::Instant::now() + SELECTION_WINDOW;
    let attempt = async {
        let mut results = tokio::task::JoinSet::new();
        for (_, sender) in peers {
            results.spawn(async move {
                sender
                    .nearby_drop_challenge()
                    .await
                    .map(|token| (sender, token))
            });
        }
        let mut selected = None;
        while let Some(result) = results.join_next().await {
            let (sender, token) = result.map_err(|_| ErrorCode::InternalError)??;
            if let Some(token) = token {
                if selected.is_some() {
                    return Err(ErrorCode::Conflict.into());
                }
                selected = Some((sender, token));
            }
        }
        let (sender, token) = selected.ok_or(ErrorCode::PeerUnavailable)?;
        sender.record_nearby_drop(token).await
    };
    tokio::select! {
        biased;
        _ = gesture.cancelled() => Err(ErrorCode::Cancelled.into()),
        result = tokio::time::timeout_at(deadline, attempt) =>
            result.map_err(|_| ErrorCode::PeerUnavailable)?,
    }
}
