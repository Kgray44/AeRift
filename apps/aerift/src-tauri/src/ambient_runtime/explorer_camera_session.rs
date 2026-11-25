//! Native qualification-owned camera attachment. Do not expose over IPC or
//! create at app startup. Fresh explicit choice is required after interruption.
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Instant,
};

use aerift_transfer::ambient_camera::{CameraIssue, CameraStatus, CameraSupervisor, RgbLandmarker};

use super::explorer_gesture::{ExplorerCameraContext, ExplorerGesture};
use super::{
    AmbientRuntime, CameraMode, CaptureAnchor, Supervisor, ambient_context, camera_policy,
};
use crate::ambient_media_foundation::{NativeCameraGrant, WindowsCameraProvider};

pub(crate) mod chooser_admission;
mod indicator;
mod native_chooser;
mod notifications;

const POLL_MILLISECONDS: u32 = 20;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExplorerCameraEnd {
    Stopped,
    ContextLost,
    AlreadyOwned,
    NotificationUnavailable,
    Unavailable(CameraIssue),
}

pub(crate) struct ExplorerCameraSession {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<ExplorerCameraEnd>>,
}

impl ExplorerCameraSession {
    /// Signal before joining. Call from a native teardown worker, not the UI.
    pub(crate) fn stop(mut self) -> ExplorerCameraEnd {
        self.join()
    }

    /// Poll from the native owner to surface permission/model/device failure.
    pub(crate) fn is_finished(&self) -> bool {
        self.worker.as_ref().is_none_or(JoinHandle::is_finished)
    }

    fn join(&mut self) -> ExplorerCameraEnd {
        self.stop.store(true, Ordering::Release);
        let Some(worker) = self.worker.take() else {
            return ExplorerCameraEnd::Stopped;
        };
        worker.thread().unpark();
        worker
            .join()
            .unwrap_or(ExplorerCameraEnd::Unavailable(CameraIssue::WorkerPanicked))
    }
}

impl Drop for ExplorerCameraSession {
    fn drop(&mut self) {
        let _ = self.join();
    }
}

struct Exclusive(Arc<Supervisor>);

impl Drop for Exclusive {
    fn drop(&mut self) {
        self.0.explorer_camera_owned.store(false, Ordering::Release);
    }
}

impl AmbientRuntime {
    /// Only a native owner with a deliberately chosen, currently granted device
    /// may call this. This session installs and owns its own visible indication.
    /// No permission prompt at acquisition. Require an eligible Explorer foreground.
    pub(crate) fn start_explorer_camera_session(
        &self,
        anchor: CaptureAnchor,
        expected_epoch: u64,
        grant: NativeCameraGrant,
        model: impl RgbLandmarker,
    ) -> Result<ExplorerCameraSession, ExplorerCameraEnd> {
        grant.allowed().map_err(ExplorerCameraEnd::Unavailable)?;
        let runtime = self.clone();
        let (origin_epoch, policy) = runtime.explorer_session_policy(anchor)?;
        if origin_epoch != expected_epoch {
            return Err(ExplorerCameraEnd::ContextLost);
        }
        runtime
            .0
            .explorer_camera_owned
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| ExplorerCameraEnd::AlreadyOwned)?;
        let exclusive = Exclusive(runtime.0.clone());
        let stop = Arc::new(AtomicBool::new(false));
        let stop_worker = stop.clone();
        let worker = thread::Builder::new()
            .name("aerift-explorer-camera-owner".into())
            .spawn(move || {
                let _exclusive = exclusive;
                let events = match notifications::Notifications::subscribe() {
                    Ok(events) => events,
                    Err(()) => return ExplorerCameraEnd::NotificationUnavailable,
                };
                let invalidated = events.latch();
                let grant = Arc::new(grant);
                if stop_worker.load(Ordering::Acquire)
                    || events.drain().is_err()
                    || runtime.explorer_session_policy(anchor).is_err()
                {
                    return ExplorerCameraEnd::ContextLost;
                }
                let surface = match indicator::Surface::display() {
                    Ok(surface) => surface,
                    Err(issue) => return ExplorerCameraEnd::Unavailable(issue),
                };
                // Declared after surface; sensor and indicator guard are joined
                // before the visible native surface is destroyed.
                let indicator = surface.occupancy();
                let provider = WindowsCameraProvider::with_shared_grant(
                    model,
                    indicator::ProviderIndicator(indicator.clone()),
                    grant.clone(),
                );
                let camera = match CameraSupervisor::spawn(provider) {
                    Ok(camera) => camera,
                    Err(_) => {
                        return ExplorerCameraEnd::Unavailable(CameraIssue::DeviceUnavailable);
                    }
                };
                let continuing = |context| same_epoch(origin_epoch, policy.camera_mode(), context);
                if !continuing(runtime.explorer_session_policy(anchor).ok()) {
                    return ExplorerCameraEnd::ContextLost;
                }
                if let Err(issue) = grant.allowed() {
                    return ExplorerCameraEnd::Unavailable(issue);
                }
                if events.drain().is_err() {
                    return ExplorerCameraEnd::ContextLost;
                }
                if !surface.check() {
                    return ExplorerCameraEnd::Unavailable(CameraIssue::IndicatorUnavailable);
                }
                camera.configure(policy, !stop_worker.load(Ordering::Acquire));
                let mut gesture = ExplorerGesture::default();
                let mut context = None;
                let end = loop {
                    if stop_worker.load(Ordering::Acquire) {
                        break ExplorerCameraEnd::Stopped;
                    }
                    if events.drain().is_err() {
                        break ExplorerCameraEnd::ContextLost;
                    }
                    if let Err(issue) = grant.allowed() {
                        break ExplorerCameraEnd::Unavailable(issue);
                    }
                    if !continuing(runtime.explorer_session_policy(anchor).ok()) {
                        break ExplorerCameraEnd::ContextLost;
                    }
                    if !surface.check() {
                        break ExplorerCameraEnd::Unavailable(CameraIssue::IndicatorUnavailable);
                    }
                    match camera.status() {
                        CameraStatus::Running(mode) if mode == policy.camera_mode() => {
                            let now = Instant::now();
                            let authority = *context.get_or_insert(ExplorerCameraContext {
                                anchor,
                                epoch: origin_epoch,
                                active_since: now,
                            });
                            if let Some(pickup) =
                                gesture.observe(Some(authority), camera.take_latest(), now)
                            {
                                // This callback may run while Ambient config is locked or
                                // on a hashing worker. No config lock and no owned camera.
                                if events.drain().is_err() {
                                    break ExplorerCameraEnd::ContextLost;
                                }
                                if !surface.check() || !indicator.occupying() {
                                    break ExplorerCameraEnd::Unavailable(
                                        CameraIssue::IndicatorUnavailable,
                                    );
                                }
                                let stop = stop_worker.clone();
                                let invalidated = invalidated.clone();
                                let indicator = indicator.clone();
                                let runtime_weak = Arc::downgrade(&runtime.0);
                                let grant = grant.clone();
                                runtime.request_explorer_gesture(pickup, move || {
                                    let runtime = runtime_weak.upgrade()?;
                                    (live_authority(
                                        stop.load(Ordering::Acquire)
                                            || invalidated.load(Ordering::Acquire),
                                        runtime.generation.load(Ordering::Acquire) == origin_epoch,
                                        ambient_context::interactive_session(),
                                        grant.allowed().is_ok(),
                                        indicator.occupying(),
                                    ))
                                    .then_some(authority)
                                });
                            }
                        }
                        CameraStatus::Unavailable(issue) => {
                            break ExplorerCameraEnd::Unavailable(issue);
                        }
                        // There is no restart for a session once its live lease is lost.
                        _ if context.is_some() => break ExplorerCameraEnd::ContextLost,
                        _ => {}
                    }
                    if events.wait(POLL_MILLISECONDS).is_err() {
                        break ExplorerCameraEnd::ContextLost;
                    }
                };
                // Revoke pending capture before the worker waits for sensor teardown.
                stop_worker.store(true, Ordering::Release);
                camera.configure(Default::default(), false);
                match camera.shutdown() {
                    Ok(()) => end,
                    Err(issue) => ExplorerCameraEnd::Unavailable(issue),
                }
            })
            .map_err(|_| ExplorerCameraEnd::Unavailable(CameraIssue::DeviceUnavailable))?;
        Ok(ExplorerCameraSession {
            stop,
            worker: Some(worker),
        })
    }

    fn explorer_session_policy(
        &self,
        anchor: CaptureAnchor,
    ) -> Result<(u64, aerift_transfer::ambient::AmbientPolicy), ExplorerCameraEnd> {
        let cfg = self
            .0
            .config
            .lock()
            .map_err(|_| ExplorerCameraEnd::ContextLost)?;
        if ambient_context::capture_anchor().ok() != Some(anchor)
            || ambient_context::foreground_executable().as_deref() != Some("explorer.exe")
        {
            return Err(ExplorerCameraEnd::ContextLost);
        }
        let policy = camera_policy(&cfg, Some("explorer.exe"));
        if !policy.may_capture()
            || policy.camera_mode() == CameraMode::Suspended
            || ambient_context::capture_anchor().ok() != Some(anchor)
        {
            return Err(ExplorerCameraEnd::ContextLost);
        }
        Ok((self.0.generation.load(Ordering::Acquire), policy))
    }
}

fn same_epoch(
    epoch: u64,
    mode: CameraMode,
    observed: Option<(u64, aerift_transfer::ambient::AmbientPolicy)>,
) -> bool {
    observed.is_some_and(|(observed_epoch, policy)| {
        observed_epoch == epoch && policy.camera_mode() == mode
    })
}

fn live_authority(
    stopped: bool,
    epoch_current: bool,
    unlocked: bool,
    permitted: bool,
    leased: bool,
) -> bool {
    !stopped && epoch_current && unlocked && permitted && leased
}

#[cfg(test)]
mod tests {
    use super::*;
    use aerift_transfer::ambient::{AmbientPolicy, SessionActivity};

    #[test]
    fn rejects_every_missing_live_authority() {
        assert!(live_authority(false, true, true, true, true));
        for i in 0..5 {
            let mut a = [false, true, true, true, true];
            a[i] = !a[i];
            assert!(!live_authority(a[0], a[1], a[2], a[3], a[4]));
        }
    }

    #[test]
    fn does_not_reuse_authority_under_revised_policy() {
        let allowed = AmbientPolicy {
            enabled: true,
            session: SessionActivity::Unlocked,
            ..Default::default()
        };
        let mode = allowed.camera_mode();
        assert!(same_epoch(4, mode, Some((4, allowed))));
        assert!(!same_epoch(4, mode, Some((5, allowed))));
        assert!(!same_epoch(4, mode, None));
        let suspended = AmbientPolicy {
            paused: true,
            ..allowed
        };
        assert!(!same_epoch(4, mode, Some((4, suspended))));
    }
}
