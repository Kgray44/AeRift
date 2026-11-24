//! Local, inert consumer of the existing authenticated A6 broker.
//! No untrusted window, registry, listener, or proposal ingress is installed here.
use aerift_transfer::{
    ambient::{FrozenCapture, RiftObjectKind},
    ambient_browser::{BrowserProposalBroker, ProposalStatus},
    ErrorCode, TransferError,
};
use serde::Serialize;
use std::{
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Default)]
pub(crate) struct BrowserReviewRuntime(Mutex<State>);

#[derive(Default)]
struct State {
    broker: BrowserProposalBroker,
    held: Option<(Instant, FrozenCapture)>,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum View {
    Unavailable,
    Ready,
    Waiting,
    Review {
        id: Uuid,
        kind: RiftObjectKind,
        literal: String,
    },
    Held {
        kind: RiftObjectKind,
    },
}

fn permits_window(label: &str, interactive: bool) -> bool {
    label == "main" && interactive
}

impl State {
    fn clear(&mut self) {
        self.broker.cancel();
        self.held = None;
    }

    fn view(&mut self, now: Instant) -> View {
        let proposal = self.broker.status(now);
        if matches!(proposal, ProposalStatus::Unavailable) {
            self.held = None;
            return View::Unavailable;
        }
        if self
            .held
            .as_ref()
            .is_some_and(|(expires, _)| now >= *expires)
        {
            self.held = None;
        }
        if let Some((_, capture)) = &self.held {
            return View::Held { kind: capture.kind };
        }
        match proposal {
            ProposalStatus::Ready => View::Ready,
            ProposalStatus::Waiting => View::Waiting,
            ProposalStatus::Review(review) => View::Review {
                id: review.id,
                kind: review.kind,
                literal: review.literal.clone(),
            },
            ProposalStatus::Unavailable => View::Unavailable,
        }
    }

    fn retain(&mut self, id: Uuid, now: Instant) -> Result<View, TransferError> {
        if self.held.is_some() {
            return Err(ErrorCode::Conflict.into());
        }
        let capture = self
            .broker
            .confirm(id, now)
            .map_err(|_| ErrorCode::InvalidRequest)?;
        self.held = Some((now + Duration::from_secs(45), capture));
        Ok(self.view(now))
    }
}

impl BrowserReviewRuntime {
    fn state(&self) -> Result<MutexGuard<'_, State>, TransferError> {
        self.0.lock().map_err(|_| ErrorCode::InternalError.into())
    }
}

#[tauri::command]
pub(crate) fn browser_review_status(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, BrowserReviewRuntime>,
) -> Result<View, TransferError> {
    if window.label() != "main" {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let mut state = runtime.state()?;
    if !permits_window(
        window.label(),
        crate::ambient_context::interactive_session(),
    ) {
        state.clear();
        return Ok(View::Unavailable);
    }
    if window.is_focused().ok() != Some(true) {
        return Ok(View::Unavailable);
    }
    Ok(state.view(Instant::now()))
}

#[tauri::command]
pub(crate) fn retain_browser_review(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, BrowserReviewRuntime>,
    id: Uuid,
) -> Result<View, TransferError> {
    if window.label() != "main" {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let mut state = runtime.state()?;
    if !permits_window(
        window.label(),
        crate::ambient_context::interactive_session(),
    ) {
        state.clear();
        return Err(ErrorCode::InvalidRequest.into());
    }
    if window.is_focused().ok() != Some(true) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let now = Instant::now();
    let _ = state.view(now);
    state.retain(id, now)
}

#[tauri::command]
pub(crate) fn clear_browser_review(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, BrowserReviewRuntime>,
) -> Result<(), TransferError> {
    if window.label() != "main" {
        return Err(ErrorCode::InvalidRequest.into());
    }
    runtime.state()?.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_companion_never_accepts_a_renderer_supplied_id() {
        let mut state = State::default();
        let now = Instant::now();
        assert!(matches!(state.view(now), View::Unavailable));
        assert_eq!(
            state.retain(Uuid::new_v4(), now).err().unwrap().code,
            ErrorCode::InvalidRequest
        );
        assert!(state.held.is_none());
    }

    #[test]
    fn only_main_window_in_an_interactive_session_can_read_or_confirm() {
        assert!(permits_window("main", true));
        assert!(!permits_window("main", false));
        assert!(!permits_window("desktop-transfer-preview", true));
    }
}
