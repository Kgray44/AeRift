//! Native command implementation, not a WebView command or startup hook.
//! DLL/model selection is fixed to the application resource root.
use super::chooser_admission::CameraChooser;
use super::native_chooser::{ConfirmedNativeChoice, enumerate_choices, show_choice};
use super::{
    AmbientRuntime, CaptureAnchor, ExplorerCameraEnd, ExplorerCameraSession, ambient_context,
};
use crate::ambient_native_model::VerifiedWindowsLandmarker;
use aerift_transfer::ambient_camera::CameraIssue;
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;

const CHOICE_LIFETIME: Duration = Duration::from_secs(30);
const MODEL_RESOURCE_DIRECTORY: &str = "ambient-camera-model";

struct Slot<P, R> {
    epoch: u64,
    state: State<P, R>,
}
enum State<P, R> {
    Idle,
    Choosing(Instant),
    Pending(Instant, P),
    Running(R),
}
impl<P, R> Default for Slot<P, R> {
    fn default() -> Self {
        Self {
            epoch: 0,
            state: State::Idle,
        }
    }
}
impl<P, R> Slot<P, R> {
    fn reserve(&mut self, now: Instant) -> Option<u64> {
        if matches!(&self.state, State::Choosing(began) | State::Pending(began, _) if !recent(*began, now))
        {
            self.state = State::Idle;
        }
        if !matches!(self.state, State::Idle) {
            return None;
        }
        self.epoch = self.epoch.checked_add(1)?;
        self.state = State::Choosing(now);
        Some(self.epoch)
    }

    fn publish(&mut self, ticket: u64, choice: P, now: Instant) -> bool {
        if self.epoch != ticket {
            return false;
        }
        if let State::Choosing(began) = self.state {
            if recent(began, now) {
                self.state = State::Pending(began, choice);
                return true;
            }
            self.state = State::Idle;
        }
        false
    }

    fn cancel_choice(&mut self, ticket: u64) {
        if self.epoch == ticket && matches!(self.state, State::Choosing(_)) {
            self.state = State::Idle;
        }
    }

    fn take_choice(&mut self, now: Instant) -> Option<P> {
        if !matches!(self.state, State::Pending(..)) {
            return None;
        }
        match std::mem::replace(&mut self.state, State::Idle) {
            State::Pending(began, choice) if recent(began, now) => Some(choice),
            _ => None,
        }
    }
}
fn recent(began: Instant, now: Instant) -> bool {
    now.checked_duration_since(began)
        .is_some_and(|elapsed| elapsed < CHOICE_LIFETIME)
}

#[derive(Default)]
pub(crate) struct NativeCameraCommands(Mutex<Slot<ConfirmedNativeChoice, ExplorerCameraSession>>);

pub(crate) struct ChoiceRequest {
    ticket: u64,
    anchor: CaptureAnchor,
    generation: u64,
}

impl NativeCameraCommands {
    /// Deliberate native request while Explorer is foreground. A trusted host
    /// should schedule finish_choice only after that request, not on startup.
    pub(crate) fn begin_choice(
        &self,
        runtime: &AmbientRuntime,
    ) -> Result<ChoiceRequest, ExplorerCameraEnd> {
        let anchor =
            ambient_context::capture_anchor().map_err(|_| ExplorerCameraEnd::ContextLost)?;
        let (generation, _) = runtime.explorer_session_policy(anchor)?;
        let mut slot = self.0.lock().map_err(|_| ExplorerCameraEnd::ContextLost)?;
        if matches!(&slot.state, State::Running(session) if session.is_finished()) {
            // The worker already exited; dropping joins no live sensor work.
            slot.state = State::Idle;
        }
        let ticket = slot
            .reserve(Instant::now())
            .ok_or(ExplorerCameraEnd::AlreadyOwned)?;
        Ok(ChoiceRequest {
            ticket,
            anchor,
            generation,
        })
    }

    /// Caller dispatches this from the app-owned UI thread. Metadata work
    /// has run on a background worker, with no camera acquisition.
    pub(crate) fn finish_choice(
        &self,
        runtime: &AmbientRuntime,
        request: ChoiceRequest,
        owner: HWND,
        inventory: Result<Vec<super::chooser_admission::NativeCameraChoice>, CameraIssue>,
    ) -> Result<bool, ExplorerCameraEnd> {
        let chosen = (|| {
            let (generation, _) = runtime.explorer_session_policy(request.anchor)?;
            if generation != request.generation {
                return Err(ExplorerCameraEnd::ContextLost);
            }
            let began = {
                let slot = self.0.lock().map_err(|_| ExplorerCameraEnd::ContextLost)?;
                match slot.state {
                    State::Choosing(began)
                        if slot.epoch == request.ticket && recent(began, Instant::now()) =>
                    {
                        began
                    }
                    _ => return Err(ExplorerCameraEnd::ContextLost),
                }
            };
            let snapshot = CameraChooser::new(
                (request.anchor, request.generation),
                began,
                inventory.map_err(ExplorerCameraEnd::Unavailable)?,
            )
            .map_err(ExplorerCameraEnd::Unavailable)?;
            show_choice(owner, snapshot).map_err(ExplorerCameraEnd::Unavailable)
        })();
        let mut slot = self.0.lock().map_err(|_| ExplorerCameraEnd::ContextLost)?;
        match chosen {
            Ok(Some(selection)) => Ok(slot.publish(request.ticket, selection, Instant::now())),
            other => {
                slot.cancel_choice(request.ticket);
                other.map(|_| false)
            }
        }
    }

    pub(crate) fn device_metadata()
    -> Result<Vec<super::chooser_admission::NativeCameraChoice>, CameraIssue> {
        enumerate_choices()
    }

    /// Second deliberate native command, no simulated focus restore. Keep the
    /// sole active handle here until explicit teardown or observed completion.
    pub(crate) fn start(
        &self,
        runtime: &AmbientRuntime,
        app: &AppHandle,
    ) -> Result<(), ExplorerCameraEnd> {
        let mut slot = self.0.lock().map_err(|_| ExplorerCameraEnd::ContextLost)?;
        let choice = slot
            .take_choice(Instant::now())
            .ok_or(ExplorerCameraEnd::ContextLost)?;
        let root: PathBuf = app
            .path()
            .resource_dir()
            .map_err(|_| missing_model())?
            .join(MODEL_RESOURCE_DIRECTORY);
        if !root.is_absolute() || !root.is_dir() {
            return Err(missing_model());
        }
        // Existing landmarker opens bounded release-pinned bytes, rejects
        // reparse points and allows no env/user path or download fallback.
        let session = choice.start(runtime, VerifiedWindowsLandmarker::new(root))?;
        slot.state = State::Running(session);
        Ok(())
    }

    /// Run on a native worker (joining camera teardown may block). Invalidates
    /// an actually selected or merely pending choice before doing teardown.
    pub(crate) fn stop(&self) -> Result<ExplorerCameraEnd, ExplorerCameraEnd> {
        let status = {
            let mut slot = self.0.lock().map_err(|_| ExplorerCameraEnd::ContextLost)?;
            std::mem::replace(&mut slot.state, State::Idle)
        };
        Ok(match status {
            State::Running(session) => session.stop(),
            _ => ExplorerCameraEnd::Stopped,
        })
    }
}
fn missing_model() -> ExplorerCameraEnd {
    ExplorerCameraEnd::Unavailable(CameraIssue::ModelUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_choice_is_single_use_and_cannot_cross_cancel_or_expiry() {
        let mut slot = Slot::<u8, ()>::default();
        let now = Instant::now();
        let old = slot.reserve(now).unwrap();
        assert!(slot.reserve(now).is_none());
        slot.cancel_choice(old);
        let live = slot.reserve(now).unwrap();
        assert!(!slot.publish(old, 0, now));
        assert!(slot.publish(live, 1, now));
        assert_eq!(slot.take_choice(now), Some(1));
        assert_eq!(slot.take_choice(now), None);
        let stale = slot.reserve(now).unwrap();
        assert!(!slot.publish(stale, 2, now + CHOICE_LIFETIME));
        assert_eq!(slot.take_choice(now + CHOICE_LIFETIME), None);
    }
}
