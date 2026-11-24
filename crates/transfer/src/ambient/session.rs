//! Host-only Ambient A4 session. The network adapter authenticates drop claims;
//! a drop selects an endpoint, never consents to the later transfer offer.
use super::{FrozenCapture, ReceiverCapabilities, Representation};
use crate::{Connector, PeerId, Sender, State, Status, TransferError};
use serde::Serialize;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    Nearby,
    MyDevices,
    Remote,
    Friends,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropError {
    Closed,
    Invalid,
    Ambiguous,
    NoDrop,
    WindowOpen,
    Unauthorized,
}

/// Local policy must independently authorize the exact peer *and* lane.
/// This interface is for native callers only, not deserialized renderer data.
pub trait DropAuthority {
    fn permits(&self, peer: PeerId, lane: Lane) -> bool;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    version: u8,
    interaction: Uuid,
    sequence: u32,
    phase: &'static str,
    count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verified: Option<bool>,
}

impl Frame {
    pub fn projection(&self) -> (Uuid, u32, &'static str, usize, Option<f64>, Option<bool>) {
        (
            self.interaction,
            self.sequence,
            self.phase,
            self.count,
            self.progress,
            self.verified,
        )
    }
}

pub struct HeldSession {
    id: Uuid,
    capture: Arc<FrozenCapture>,
    lane: Lane,
    expires: Instant,
    settle: Option<Instant>,
    first: Option<PeerId>,
    ambiguous: bool,
    closed: bool,
}
pub struct Dispatch {
    id: Uuid,
    capture: Arc<FrozenCapture>,
    lane: Lane,
    peer: PeerId,
    expires: Instant,
}

impl HeldSession {
    pub fn pickup(capture: FrozenCapture, lane: Lane, now: Instant) -> Option<Self> {
        if capture.negotiate(ReceiverCapabilities::V1).ok()? != Representation::SingleRawFile {
            return None;
        }
        Some(Self {
            id: Uuid::new_v4(),
            capture: Arc::new(capture),
            lane,
            expires: now.checked_add(Duration::from_secs(30))?,
            settle: None,
            first: None,
            ambiguous: false,
            closed: false,
        })
    }

    pub fn id(&self) -> Uuid {
        self.id
    }

    pub fn held_frame(&self) -> Frame {
        frame(self.id, 1, "held", None)
    }

    /// Call only after verifying a session-bound, explicit drop on the
    /// authenticated channel (the peer argument must come from TLS, not the body).
    pub fn drop_claim(
        &mut self,
        session: Uuid,
        peer: PeerId,
        lane: Lane,
        now: Instant,
        auth: &impl DropAuthority,
    ) -> Result<(), DropError> {
        if self.closed || now >= self.expires || self.settle.is_some_and(|end| now >= end) {
            return Err(DropError::Closed);
        }
        if session != self.id || lane != self.lane {
            return Err(DropError::Invalid);
        }
        if !auth.permits(peer, lane) {
            return Err(DropError::Unauthorized);
        }
        if let Some(first) = self.first {
            if first != peer {
                self.ambiguous = true;
            }
        } else {
            self.first = Some(peer);
            self.settle = now.checked_add(Duration::from_millis(500));
        }
        Ok(())
    }

    pub fn cancel(self) -> Option<Frame> {
        (!self.closed).then(|| frame(self.id, 2, "cancelled", None))
    }

    pub(super) fn accepts_claim_at(&self, now: Instant) -> bool {
        !self.closed && now < self.expires && self.settle.is_none_or(|end| now < end)
    }

    pub fn revoke(&mut self) {
        self.closed = true;
    }

    pub fn expire(&mut self, now: Instant) -> Option<Frame> {
        if self.closed || now < self.expires {
            return None;
        }
        self.closed = true;
        Some(frame(self.id, 2, "expired", None))
    }

    pub fn ambiguous_frame(&self) -> Option<Frame> {
        self.ambiguous.then(|| frame(self.id, 2, "ambiguous", None))
    }

    pub fn resolve(
        &mut self,
        now: Instant,
        auth: &impl DropAuthority,
    ) -> Result<Dispatch, DropError> {
        if self.closed || now >= self.expires {
            return Err(DropError::Closed);
        }
        let start = self.settle.ok_or(DropError::NoDrop)?;
        if now < start {
            return Err(DropError::WindowOpen);
        }
        self.closed = true;
        if self.ambiguous {
            return Err(DropError::Ambiguous);
        }
        let peer = self.first.ok_or(DropError::NoDrop)?;
        if !auth.permits(peer, self.lane) {
            return Err(DropError::Unauthorized);
        }
        Ok(Dispatch {
            id: self.id,
            capture: self.capture.clone(),
            lane: self.lane,
            peer,
            expires: self.expires,
        })
    }
}

impl Dispatch {
    pub(super) fn receipt_source(&self) -> (Uuid, PeerId, String, u64) {
        let source = self.capture.entries()[0].manifest();
        (self.id, self.peer, source.title.clone(), source.size)
    }

    /// Consumes the dispatch. The native factory must pin the exact supplied
    /// identity and lane, and use its normal revocation/consent-aware connector.
    pub async fn send<C: Connector>(
        self,
        auth: &impl DropAuthority,
        scoped_sender: impl FnOnce(PeerId, Lane) -> Option<Sender<C>>,
        cancel: CancellationToken,
        emit: impl Fn(Frame) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        self.send_observed(auth, scoped_sender, cancel, emit, |_, _| {})
            .await
    }

    pub(super) async fn send_observed<C: Connector>(
        self,
        auth: &impl DropAuthority,
        scoped_sender: impl FnOnce(PeerId, Lane) -> Option<Sender<C>>,
        cancel: CancellationToken,
        emit: impl Fn(Frame) + Send + Sync + 'static,
        status_update: impl Fn(Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        use std::sync::atomic::{AtomicU32, Ordering};
        if Instant::now() >= self.expires || !auth.permits(self.peer, self.lane) {
            emit(frame(self.id, 2, "rejected", None));
            return Err(crate::ErrorCode::PeerUntrusted.into());
        }
        let Some(sender) = scoped_sender(self.peer, self.lane) else {
            emit(frame(self.id, 2, "disconnected", None));
            return Err(crate::ErrorCode::PeerUnavailable.into());
        };
        emit(frame(self.id, 2, "released", None));
        let emit = Arc::new(emit);
        let progress_emit = emit.clone();
        let next = Arc::new(AtomicU32::new(3));
        let seq = next.clone();
        let size = self.capture.entries()[0].manifest().size;
        let result = sender
            .send_frozen_file_with_id(self.id, self.capture, cancel, move |id, status| {
                // Publish terminal status only from the final authenticated return.
                if !status.state.is_terminal() {
                    status_update(id, status);
                }
                let (phase, progress) = match status.state {
                    State::Pending => ("awaiting-acceptance", None),
                    State::Accepted | State::Transferring => (
                        "transferring",
                        Some(if size == 0 {
                            0.0
                        } else {
                            (status.bytes_transferred as f64 / size as f64).min(1.0)
                        }),
                    ),
                    _ => return,
                };
                progress_emit(frame(
                    id,
                    seq.fetch_add(1, Ordering::Relaxed),
                    phase,
                    progress,
                ));
            })
            .await;
        let phase = match result {
            Ok(s) if s.state == State::Completed && s.bytes_transferred == size => "completed",
            Ok(s) if s.state == State::Rejected => "rejected",
            Ok(s) if s.state == State::Cancelled => "cancelled",
            _ => "failed",
        };
        emit(frame(self.id, next.load(Ordering::Relaxed), phase, None));
        result
    }
}

fn frame(interaction: Uuid, sequence: u32, phase: &'static str, progress: Option<f64>) -> Frame {
    Frame {
        version: 1,
        interaction,
        sequence,
        phase,
        count: 1,
        progress,
        verified: (phase == "completed").then_some(true),
    }
}
