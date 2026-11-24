//! Host-owned opt-in lifecycle for Ambient Nearby. No renderer IPC,
//! camera producer, global discovery, or generic listener is installed here.
use super::{
    FrozenCapture,
    nearby_drop::{NearbyDrop, claim_only_nearby_pickup},
    session::{Dispatch, DropAuthority, DropError, Frame, Lane},
};
use crate::{Connector, ErrorCode, PeerId, Sender, Status, TransferError};
use std::{
    sync::{Arc, Mutex, Weak},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct NearbyRuntime {
    state: Mutex<Lifecycle>,
}

#[derive(Default)]
struct Lifecycle {
    enabled: bool,
    interactive: bool,
    paused: bool,
    generation: CancellationToken,
    pickup: Option<Arc<NearbyDrop>>,
}

/// One native runner's exact pickup. It cannot be constructed outside this
/// runtime, and it does not keep the file alive after replacement or revocation.
#[derive(Debug)]
pub struct PickupLease {
    pickup: Weak<NearbyDrop>,
    generation: CancellationToken,
}

impl PickupLease {
    pub fn frame(&self) -> Option<Frame> {
        if self.generation.is_cancelled() {
            return None;
        }
        self.pickup.upgrade()?.held_frame()
    }

    pub async fn cancelled(&self) {
        self.generation.cancelled().await;
    }
}

pub struct NativeDispatch {
    dispatch: Dispatch,
    generation: CancellationToken,
}

impl Lifecycle {
    fn allowed(&self) -> bool {
        self.enabled && self.interactive && !self.paused
    }

    fn invalidate(&mut self) {
        self.generation.cancel();
        if let Some(previous) = self.pickup.take() {
            previous.close();
        }
        self.generation = CancellationToken::new();
    }
}

impl NearbyRuntime {
    /// Host-native user settings and interactive desktop status, not IPC
    /// data from a browser extension or overlay. Entering an allowed state
    /// does not restore a revoked pickup or generate a drop.
    pub fn set_policy(&self, enabled: bool, interactive: bool, paused: bool) {
        if let Ok(mut state) = self.state.lock() {
            if (state.enabled, state.interactive, state.paused) != (enabled, interactive, paused) {
                state.invalidate();
                state.enabled = enabled;
                state.interactive = interactive;
                state.paused = paused;
            }
        }
    }

    /// Call only from a trusted, explicit local pickup after native A2
    /// resolution. It consumes the frozen object, never a renderer path.
    pub fn pickup(
        &self,
        capture: FrozenCapture,
        now: Instant,
    ) -> Result<PickupLease, TransferError> {
        let mut state = self.state.lock().map_err(|_| ErrorCode::InternalError)?;
        if !state.allowed() {
            return Err(ErrorCode::Conflict.into());
        }
        let next = Arc::new(NearbyDrop::open(capture, now).ok_or(ErrorCode::InvalidRequest)?);
        state.invalidate();
        let lease = PickupLease {
            pickup: Arc::downgrade(&next),
            generation: state.generation.clone(),
        };
        state.pickup = Some(next);
        Ok(lease)
    }

    /// Keep the generation token alongside the source when attaching to the
    /// dedicated Nearby route. The route must also check the connection grant.
    pub fn source(&self) -> Option<(Option<Arc<NearbyDrop>>, CancellationToken)> {
        let state = self.state.lock().ok()?;
        state
            .allowed()
            .then(|| (state.pickup.clone(), state.generation.clone()))
    }

    pub fn resolve_guarded(
        &self,
        now: Instant,
        authority: &impl DropAuthority,
        lease: &PickupLease,
    ) -> Result<NativeDispatch, DropError> {
        let state = self.state.lock().map_err(|_| DropError::Closed)?;
        if lease.generation.is_cancelled() || !state.allowed() {
            return Err(DropError::Closed);
        }
        let source = state.pickup.as_ref().ok_or(DropError::Closed)?;
        if !lease.pickup.ptr_eq(&Arc::downgrade(source)) {
            return Err(DropError::Closed);
        }
        let dispatch = source.resolve(now, authority)?;
        Ok(NativeDispatch {
            dispatch,
            generation: state.generation.clone(),
        })
    }

    /// Trigger only from a local native drop action, with platform-pinned
    /// LAN peers supplied by the live Nearby session, not renderer authority.
    pub async fn explicit_drop<C: Connector + 'static>(
        &self,
        peers: Vec<(PeerId, Sender<C>)>,
    ) -> Result<(), TransferError> {
        let (_, generation) = self.source().ok_or(ErrorCode::Conflict)?;
        claim_only_nearby_pickup(peers, &generation).await
    }

    pub fn cancel(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.invalidate();
        }
    }
}

impl NativeDispatch {
    pub fn receipt_source(&self) -> (uuid::Uuid, PeerId, String, u64) {
        self.dispatch.receipt_source()
    }

    pub fn cancellation(&self) -> CancellationToken {
        self.generation.clone()
    }

    pub async fn send_observed<C: Connector>(
        self,
        auth: &impl DropAuthority,
        scoped_sender: impl FnOnce(PeerId, Lane) -> Option<Sender<C>>,
        emit: impl Fn(Frame) + Send + Sync + 'static,
        status_update: impl Fn(uuid::Uuid, Status) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        if self.generation.is_cancelled() {
            return Err(ErrorCode::Cancelled.into());
        }
        self.dispatch
            .send_observed(auth, scoped_sender, self.generation, emit, status_update)
            .await
    }

    pub async fn send<C: Connector>(
        self,
        auth: &impl DropAuthority,
        scoped_sender: impl FnOnce(PeerId, Lane) -> Option<Sender<C>>,
        emit: impl Fn(Frame) + Send + Sync + 'static,
    ) -> Result<Status, TransferError> {
        if self.generation.is_cancelled() {
            return Err(ErrorCode::Cancelled.into());
        }
        self.dispatch
            .send(auth, scoped_sender, self.generation, emit)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ambient::{Candidate, CaptureContext, CaptureLimits, freeze};

    #[test]
    fn local_pickup_lease_binds_resolution_to_one_runtime_and_capture() {
        struct NoAuthority;
        impl DropAuthority for NoAuthority {
            fn permits(&self, _: PeerId, _: Lane) -> bool {
                false
            }
        }
        let first_runtime = NearbyRuntime::default();
        let other_runtime = NearbyRuntime::default();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"fixture").unwrap();
        let capture = || {
            freeze(
                CaptureContext {
                    explicit_selection: vec![Candidate::path(file.path().to_owned())],
                    ..Default::default()
                },
                CaptureLimits::default(),
            )
            .unwrap()
        };

        let now = Instant::now();
        first_runtime.set_policy(true, true, false);
        other_runtime.set_policy(true, true, false);
        let first = first_runtime.pickup(capture(), now).unwrap();
        let other = other_runtime.pickup(capture(), now).unwrap();
        assert_eq!(
            first_runtime
                .resolve_guarded(now, &NoAuthority, &other)
                .err(),
            Some(DropError::Closed)
        );
        assert_eq!(
            first_runtime
                .resolve_guarded(now, &NoAuthority, &first)
                .err(),
            Some(DropError::NoDrop)
        );
        let current = first_runtime.pickup(capture(), now).unwrap();
        assert!(first.frame().is_none());
        assert!(current.frame().is_some());
        assert_eq!(
            first_runtime
                .resolve_guarded(now, &NoAuthority, &first)
                .err(),
            Some(DropError::Closed)
        );
        first_runtime.set_policy(true, false, false);
        assert!(current.frame().is_none());
        assert_eq!(
            first_runtime
                .resolve_guarded(now, &NoAuthority, &current)
                .err(),
            Some(DropError::Closed)
        );
    }

    #[test]
    fn explicit_opt_in_lock_pause_and_cancel_invalidate_without_restoring_pickup() {
        let adapter = NearbyRuntime::default();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"data").unwrap();
        let capture = || {
            freeze(
                CaptureContext {
                    explicit_selection: vec![Candidate::path(file.path().to_owned())],
                    ..Default::default()
                },
                CaptureLimits::default(),
            )
            .unwrap()
        };

        assert!(adapter.source().is_none());
        assert_eq!(
            adapter.pickup(capture(), Instant::now()).unwrap_err().code,
            ErrorCode::Conflict
        );
        adapter.set_policy(true, true, false);
        assert!(adapter.source().unwrap().0.is_none());
        adapter.pickup(capture(), Instant::now()).unwrap();
        let (first, token) = adapter.source().unwrap();
        assert!(first.is_some());
        adapter.set_policy(true, false, false);
        assert!(token.is_cancelled());
        assert!(adapter.source().is_none());
        adapter.set_policy(true, true, false);
        assert!(adapter.source().unwrap().0.is_none());
        adapter.pickup(capture(), Instant::now()).unwrap();
        let (_, token) = adapter.source().unwrap();
        adapter.set_policy(true, true, true);
        assert!(token.is_cancelled());
        adapter.set_policy(true, true, false);
        assert!(adapter.source().unwrap().0.is_none());
        adapter.pickup(capture(), Instant::now()).unwrap();
        let (_, token) = adapter.source().unwrap();
        adapter.cancel();
        assert!(token.is_cancelled());
        assert!(adapter.source().unwrap().0.is_none());
    }
}
