//! Separate, opt-in local export of an already received verified Inbox item.
//! The shortcut has no authority on its own and never changes the Inbox receiver.
use crate::{
    ambient_context::{capture_anchor, receive_destination::PendingExplorerDelivery},
    ambient_runtime::AmbientRuntime,
};
use aerift_transfer::{ErrorCode, PeerId, TransferError, TransferKey};
use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
pub(crate) struct ExplorerReceiveRuntime(Mutex<Option<Job>>);

struct Job {
    id: Uuid,
    key: TransferKey,
    name: String,
    expires: Instant,
    phase: Phase,
    stop: CancellationToken,
}

impl Job {
    fn begin_resolving(&mut self, now: Instant) -> Option<(Uuid, TransferKey)> {
        if self.expires <= now || self.stop.is_cancelled() || !matches!(self.phase, Phase::Armed) {
            return None;
        }
        self.phase = Phase::Resolving;
        Some((self.id, self.key))
    }

    fn begin_save(
        &mut self,
        id: Uuid,
        now: Instant,
    ) -> Option<(TransferKey, PendingExplorerDelivery, CancellationToken)> {
        if self.id != id
            || self.expires <= now
            || self.stop.is_cancelled()
            || !matches!(self.phase, Phase::Review(_))
        {
            return None;
        }
        let Phase::Review(target) = std::mem::replace(&mut self.phase, Phase::Saving) else {
            unreachable!("checked review phase while holding the slot lock")
        };
        Some((self.key, target, self.stop.clone()))
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

enum Phase {
    Armed,
    Resolving,
    Review(PendingExplorerDelivery),
    Saving,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum View {
    Idle,
    Armed,
    Resolving,
    Review {
        id: Uuid,
        name: String,
        folder: String,
    },
    Saving,
}

pub(crate) fn shortcut() -> Shortcut {
    Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
        Code::KeyF,
    )
}

fn permitted(app: &AppHandle) -> bool {
    app.state::<AmbientRuntime>().allows_explorer_receive()
}

impl ExplorerReceiveRuntime {
    fn clear(&self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }

    fn view(&self, app: &AppHandle) -> Result<View, TransferError> {
        if !permitted(app) {
            self.clear();
            return Ok(View::Idle);
        }
        let mut slot = self.0.lock().map_err(|_| ErrorCode::InternalError)?;
        if slot
            .as_ref()
            .is_some_and(|job| job.expires <= Instant::now() && !matches!(job.phase, Phase::Saving))
        {
            *slot = None;
        }
        Ok(match slot.as_ref() {
            None => View::Idle,
            Some(job) => match &job.phase {
                Phase::Armed => View::Armed,
                Phase::Resolving => View::Resolving,
                Phase::Review(target) => View::Review {
                    id: job.id,
                    name: job.name.clone(),
                    folder: target.display_target().to_string_lossy().into_owned(),
                },
                Phase::Saving => View::Saving,
            },
        })
    }
}

pub(crate) fn capture_focused_explorer(app: &AppHandle) {
    let runtime = app.state::<ExplorerReceiveRuntime>();
    if !permitted(app) {
        runtime.clear();
        return;
    }
    let Ok(anchor) = capture_anchor() else {
        runtime.clear();
        return;
    };
    let (id, key) = {
        let Ok(mut slot) = runtime.0.lock() else {
            return;
        };
        let Some(job) = slot.as_mut() else { return };
        if job.expires <= Instant::now() {
            *slot = None;
            return;
        }
        let Some(resolution) = job.begin_resolving(Instant::now()) else {
            return;
        };
        resolution
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let proposal = PendingExplorerDelivery::capture(anchor, key);
        let allowed = permitted(&app);
        let runtime = app.state::<ExplorerReceiveRuntime>();
        let Ok(mut slot) = runtime.0.lock() else {
            return;
        };
        let Some(job) = slot.as_mut().filter(|job| job.id == id) else {
            return;
        };
        if job.expires <= Instant::now() || !allowed || !matches!(job.phase, Phase::Resolving) {
            *slot = None;
        } else if let Ok(target) = proposal {
            job.phase = Phase::Review(target);
        } else {
            *slot = None;
        }
    });
}

fn require_main(window: &WebviewWindow) -> Result<(), TransferError> {
    if window.label() != "main" || window.is_focused().ok() != Some(true) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn arm_explorer_receive(
    window: WebviewWindow,
    peer: PeerId,
    receipt: Uuid,
) -> Result<(), TransferError> {
    require_main(&window)?;
    let app = window.app_handle().clone();
    if !permitted(&app) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let runtime = app.state::<ExplorerReceiveRuntime>();
    let key = TransferKey { peer, id: receipt };
    let inbox = crate::windows::session(&window).await?.inbox()?;
    let name = tauri::async_runtime::spawn_blocking(move || {
        inbox.verified_receipt(key).map(|r| r.offer().name.clone())
    })
    .await
    .map_err(|_| ErrorCode::InternalError)??;
    require_main(&window)?;
    if !permitted(&app) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let id = Uuid::new_v4();
    let stop = CancellationToken::new();
    {
        let mut slot = runtime.0.lock().map_err(|_| ErrorCode::InternalError)?;
        if slot.is_some() {
            return Err(ErrorCode::Conflict.into());
        }
        *slot = Some(Job {
            id,
            key,
            name,
            expires: Instant::now() + Duration::from_secs(30),
            phase: Phase::Armed,
            stop: stop.clone(),
        });
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
            let current = app.state::<ExplorerReceiveRuntime>();
            let _ = current.view(&app);
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn view_explorer_receive(window: WebviewWindow) -> Result<View, TransferError> {
    require_main(&window)?;
    window
        .state::<ExplorerReceiveRuntime>()
        .view(window.app_handle())
}

#[tauri::command]
pub(crate) fn cancel_explorer_receive(window: WebviewWindow) -> Result<(), TransferError> {
    require_main(&window)?;
    window.state::<ExplorerReceiveRuntime>().clear();
    Ok(())
}

#[tauri::command]
pub(crate) async fn confirm_explorer_receive(
    window: WebviewWindow,
    id: Uuid,
) -> Result<(), TransferError> {
    require_main(&window)?;
    let app = window.app_handle().clone();
    let inbox = crate::windows::session(&window).await?.inbox()?;
    require_main(&window)?;
    if !permitted(&app) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let profile = app
        .path()
        .app_local_data_dir()
        .map_err(|_| ErrorCode::InternalError)?;
    let runtime = app.state::<ExplorerReceiveRuntime>();
    let (key, target, stop) = {
        let mut slot = runtime.0.lock().map_err(|_| ErrorCode::InternalError)?;
        slot.as_mut()
            .and_then(|job| job.begin_save(id, Instant::now()))
            .ok_or(ErrorCode::InvalidRequest)?
    };
    let validator = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        target.authorize_save(&inbox, key, true, &profile, || {
            !stop.is_cancelled() && permitted(&validator)
        })
    })
    .await
    .map_err(|_| ErrorCode::InternalError);
    if let Ok(mut slot) = runtime.0.lock() {
        if slot.as_ref().is_some_and(|job| job.id == id) {
            *slot = None;
        }
    }
    res?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(now: Instant) -> Job {
        Job {
            id: Uuid::new_v4(),
            key: TransferKey {
                peer: PeerId::from_tls_leaf(b"synthetic pinned source"),
                id: Uuid::new_v4(),
            },
            name: "synthetic-note.txt".into(),
            expires: now + Duration::from_secs(30),
            phase: Phase::Armed,
            stop: CancellationToken::new(),
        }
    }

    #[test]
    fn explorer_shortcut_requires_exact_fresh_arm_and_consumes_it_once() {
        let now = Instant::now();
        let mut job = candidate(now);
        let expected = (job.id, job.key);
        assert_eq!(job.begin_resolving(now), Some(expected));
        assert!(job.begin_resolving(now).is_none());
        assert!(job.begin_save(job.id, now).is_none());
        let mut expired = candidate(now);
        assert!(expired
            .begin_resolving(now + Duration::from_secs(30))
            .is_none());
        let mut revoked = candidate(now);
        revoked.stop.cancel();
        assert!(revoked.begin_resolving(now).is_none());
    }

    #[test]
    fn explorer_confirmation_requires_exact_unexpired_review_and_can_save_once() {
        let now = Instant::now();
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("synthetic destination");
        std::fs::create_dir(&folder).unwrap();
        let mut job = candidate(now);
        let target =
            PendingExplorerDelivery::synthetic_target_for_test(job.key, folder.clone()).unwrap();
        job.phase = Phase::Review(target);
        assert!(job.begin_save(Uuid::new_v4(), now).is_none());
        assert!(job
            .begin_save(job.id, now + Duration::from_secs(30))
            .is_none());
        let (key, target, lease) = job.begin_save(job.id, now).unwrap();
        assert_eq!(key, job.key);
        assert_eq!(target.display_target(), folder.as_path());
        assert!(!lease.is_cancelled());
        assert!(job.begin_save(job.id, now).is_none());
        drop(job);
        assert!(lease.is_cancelled());
        assert!(!folder.join("synthetic-note.txt").exists());
    }
}
