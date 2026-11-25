use aerift_transfer::folder::{WindowsFolderDirectory, WindowsFolderReadGrant, WindowsFolderReadPage};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const UNAVAILABLE: &str = "Folder unavailable";
const DENIED: &str = "Folder selection is not available to this window";

#[derive(Default)]
pub(crate) struct WorkspaceFolderPicker(Arc<Inner>);

#[derive(Default)]
struct Inner {
    picking: AtomicBool,
    // The provisioned lab main window must never be rebound. Destruction
    // revokes the current root and prevents a late dialog result installing one.
    closed: AtomicBool,
    current: Mutex<Option<Active>>,
}

struct Active {
    grant: WindowsFolderReadGrant,
    expiry_task: tokio::task::JoinHandle<()>,
}

impl Drop for Active {
    fn drop(&mut self) {
        self.expiry_task.abort();
    }
}

struct PickLease(Arc<Inner>);

impl Drop for PickLease {
    fn drop(&mut self) {
        self.0.picking.store(false, Ordering::Release);
    }
}

impl Inner {
    fn begin(self: &Arc<Self>) -> Result<PickLease, &'static str> {
        if self.closed.load(Ordering::Acquire) {
            return Err(DENIED);
        }
        self.picking
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "A folder picker is already open")?;
        Ok(PickLease(self.clone()))
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut current) = self.current.lock() {
            *current = None;
        }
    }
}

impl WorkspaceFolderPicker {
    // Called exactly once by the isolated lab builder at setup. Never install
    // on a shell that can navigate away from its bundled local probe.
    pub(crate) fn bind_owner(&self, owner: &WebviewWindow) {
        let state = Arc::downgrade(&self.0);
        owner.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(inner) = state.upgrade() {
                    inner.close();
                }
            }
        });
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChosenFolder {
    grant: Uuid,
    cursor: Uuid,
}

// No frontend path/URI or configurable default directory is accepted.
#[tauri::command]
pub(crate) async fn workspace_choose_folder(
    window: WebviewWindow,
) -> Result<Option<ChosenFolder>, &'static str> {
    let inner = owner_state(&window)?;
    let lease = inner.begin()?;
    // Capture a runtime handle on the async side. The lease remains held by
    // the blocking work even if the invoking page drops its command future.
    let runtime = tokio::runtime::Handle::current();
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let Some(folder) = window
            .dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = folder.into_path().map_err(|_| UNAVAILABLE)?;
        let root = WindowsFolderDirectory::from_native_selection(&path).map_err(|_| UNAVAILABLE)?;
        let grant = WindowsFolderReadGrant::new(root);
        let (id, cursor) = grant.initial_tokens();
        let deadline = grant.deadline();
        let mut current = inner.current.lock().map_err(|_| UNAVAILABLE)?;
        if inner.closed.load(Ordering::Acquire) {
            return Err(DENIED);
        }
        let state = Arc::downgrade(&inner);
        let expiry_task = runtime.spawn(async move {
            tokio::time::sleep_until(deadline.into()).await;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Some(inner) = state.upgrade() {
                    let Ok(mut current) = inner.current.lock() else {
                        return;
                    };
                    if current.as_ref().is_some_and(|active| active.grant.id() == id) {
                        *current = None;
                    }
                }
            })
            .await;
        });
        *current = Some(Active { grant, expiry_task });
        Ok(Some(ChosenFolder { grant: id, cursor }))
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn workspace_list_chosen_folder(
    window: WebviewWindow,
    grant: Uuid,
    cursor: Uuid,
) -> Result<WindowsFolderReadPage, &'static str> {
    let inner = owner_state(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = inner.current.lock().map_err(|_| UNAVAILABLE)?;
        if inner.closed.load(Ordering::Acquire) {
            return Err(DENIED);
        }
        let active = current
            .as_mut()
            .filter(|active| active.grant.id() == grant)
            .ok_or(UNAVAILABLE)?;
        let result = active.grant.next(grant, cursor);
        if active.grant.finished() || Instant::now() >= active.grant.deadline() {
            *current = None;
        }
        // Never reflect native errors (which might expose path or device info).
        result.map_err(|_| UNAVAILABLE)
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn workspace_close_chosen_folder(
    window: WebviewWindow,
    grant: Uuid,
) -> Result<(), &'static str> {
    let inner = owner_state(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = inner.current.lock().map_err(|_| UNAVAILABLE)?;
        if current.as_ref().is_some_and(|active| active.grant.id() == grant) {
            *current = None;
        }
        Ok(())
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

fn owner_state(window: &WebviewWindow) -> Result<Arc<Inner>, &'static str> {
    if window.label() != "main" {
        return Err(DENIED);
    }
    // try_state is deliberate: missing lab setup fails closed.
    let state = window.try_state::<WorkspaceFolderPicker>().ok_or(DENIED)?;
    if state.0.closed.load(Ordering::Acquire) {
        return Err(DENIED);
    }
    Ok(state.0.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_lease_serializes_picks_and_releases_on_cancel() {
        let state = Arc::new(Inner::default());
        let current = state.begin().unwrap_or_else(|error| panic!("{error}"));
        assert!(state.begin().is_err());
        drop(current);
        assert!(state.begin().is_ok());
    }

    #[test]
    fn destroyed_owner_cannot_be_rebound_or_begin_picks() {
        let state = Arc::new(Inner::default());
        let current = state.begin().unwrap_or_else(|error| panic!("{error}"));
        state.close();
        drop(current);
        assert!(state.begin().is_err());
    }
}
