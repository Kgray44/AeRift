use aerift_transfer::folder::{WindowsFolderDirectory, WindowsFolderReadGrant, WindowsFolderReadPage};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const UNAVAILABLE: &str = "Folder unavailable";
const DENIED: &str = "Folder selection is not available to this window";

#[derive(Default)]
pub(crate) struct WorkspaceFolderPicker(Arc<Inner>);

#[derive(Default)]
struct Inner {
    picking: AtomicBool,
    bound: AtomicBool,
    // Main window destruction revokes the root and pending native selection.
    closed: AtomicBool,
    lifecycle: Mutex<Lifecycle>,
}

#[derive(Default)]
struct Lifecycle {
    pending: Option<Uuid>,
    current: Option<Active>,
}

impl Lifecycle {
    fn revoke(&mut self, request: Uuid) {
        if self.pending == Some(request) {
            self.pending = None;
        }
        if self
            .current
            .as_ref()
            .is_some_and(|active| active.request == request)
        {
            self.current = None;
        }
    }
}

struct Active {
    request: Uuid,
    grant: WindowsFolderReadGrant,
    expiry_task: tokio::task::JoinHandle<()>,
}

impl Drop for Active {
    fn drop(&mut self) {
        self.expiry_task.abort();
    }
}

struct PickLease(Arc<Inner>, Uuid);

impl Drop for PickLease {
    fn drop(&mut self) {
        if let Ok(mut lifecycle) = self.0.lifecycle.lock() {
            if lifecycle.pending == Some(self.1) {
                lifecycle.pending = None;
            }
        }
        self.0.picking.store(false, Ordering::Release);
    }
}

impl Inner {
    fn begin(self: &Arc<Self>, request: Uuid) -> Result<PickLease, &'static str> {
        let mut lifecycle = self.lifecycle.lock().map_err(|_| UNAVAILABLE)?;
        if self.closed.load(Ordering::Acquire) || request.get_version_num() != 4 {
            return Err(DENIED);
        }
        if lifecycle
            .current
            .as_ref()
            .is_some_and(|active| active.request == request)
        {
            return Err(DENIED);
        }
        self.picking
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "A folder picker is already open")?;
        lifecycle.pending = Some(request);
        Ok(PickLease(self.clone(), request))
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.revoke_all();
    }

    fn revoke_all(&self) {
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            *lifecycle = Lifecycle::default();
        }
    }
}

impl WorkspaceFolderPicker {
    // Called exactly once at ordinary Windows shell setup.
    pub(crate) fn bind_owner(&self, owner: &WebviewWindow) {
        if owner.label() != "main" || self.0.bound.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = Arc::downgrade(&self.0);
        let app = owner.app_handle().clone();
        owner.on_window_event(move |event| {
            let Some(inner) = state.upgrade() else {
                return;
            };
            match event {
                tauri::WindowEvent::Destroyed => inner.close(),
                // Close may hide to the tray instead of destroying the main
                // window. Clear scope without disabling the reopened shell.
                tauri::WindowEvent::CloseRequested { .. } => {
                    inner.revoke_all();
                    let _ = app.emit_to("main", "workspace-folder-cleared", ());
                }
                _ => {}
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
    request: Uuid,
) -> Result<Option<ChosenFolder>, &'static str> {
    let inner = owner_state(&window)?;
    if window.is_focused().ok() != Some(true) {
        return Err(DENIED);
    }
    let lease = inner.begin(request)?;
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
        require_bundled_main(&window)?;
        {
            let lifecycle = inner.lifecycle.lock().map_err(|_| UNAVAILABLE)?;
            if inner.closed.load(Ordering::Acquire) || lifecycle.pending != Some(request) {
                return Err(DENIED);
            }
        }
        let path = folder.into_path().map_err(|_| UNAVAILABLE)?;
        let root = WindowsFolderDirectory::from_native_selection(&path).map_err(|_| UNAVAILABLE)?;
        let grant = WindowsFolderReadGrant::new(root);
        let (id, cursor) = grant.initial_tokens();
        let deadline = grant.deadline();
        let mut lifecycle = inner.lifecycle.lock().map_err(|_| UNAVAILABLE)?;
        if inner.closed.load(Ordering::Acquire) || lifecycle.pending != Some(request) {
            return Err(DENIED);
        }
        lifecycle.pending = None;
        let state = Arc::downgrade(&inner);
        let expiry_task = runtime.spawn(async move {
            tokio::time::sleep_until(deadline.into()).await;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Some(inner) = state.upgrade() {
                    let Ok(mut lifecycle) = inner.lifecycle.lock() else {
                        return;
                    };
                    if lifecycle
                        .current
                        .as_ref()
                        .is_some_and(|active| active.grant.id() == id)
                    {
                        lifecycle.current = None;
                    }
                }
            })
            .await;
        });
        lifecycle.current = Some(Active {
            request,
            grant,
            expiry_task,
        });
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
        require_bundled_main(&window)?;
        let mut lifecycle = inner.lifecycle.lock().map_err(|_| UNAVAILABLE)?;
        if inner.closed.load(Ordering::Acquire) {
            return Err(DENIED);
        }
        let active = lifecycle.current
            .as_mut()
            .filter(|active| active.grant.id() == grant)
            .ok_or(UNAVAILABLE)?;
        let result = active.grant.next(grant, cursor);
        let expired = Instant::now() >= active.grant.deadline();
        if active.grant.finished() || expired {
            lifecycle.current = None;
        }
        if expired || inner.closed.load(Ordering::Acquire) {
            return Err(UNAVAILABLE);
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
    request: Uuid,
) -> Result<(), &'static str> {
    let inner = owner_state(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        inner.lifecycle.lock().map_err(|_| UNAVAILABLE)?.revoke(request);
        Ok(())
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

fn bundled_origin(url: &tauri::Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("http" | "https", Some("tauri.localhost")) | ("tauri", Some("localhost"))
    ) && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && matches!(url.path(), "/" | "/index.html")
}

fn require_bundled_main(window: &WebviewWindow) -> Result<(), &'static str> {
    if window.label() != "main" || !window.url().is_ok_and(|url| bundled_origin(&url)) {
        return Err(DENIED);
    }
    Ok(())
}

fn owner_state(window: &WebviewWindow) -> Result<Arc<Inner>, &'static str> {
    require_bundled_main(window)?;
    let state = window.try_state::<WorkspaceFolderPicker>().ok_or(DENIED)?;
    if !state.0.bound.load(Ordering::Acquire) || state.0.closed.load(Ordering::Acquire) {
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
        let current = state.begin(Uuid::new_v4()).unwrap_or_else(|error| panic!("{error}"));
        assert!(state.begin(Uuid::new_v4()).is_err());
        drop(current);
        assert!(state.begin(Uuid::new_v4()).is_ok());
    }

    #[test]
    fn destroyed_owner_cannot_be_rebound_or_begin_picks() {
        let state = Arc::new(Inner::default());
        let current = state.begin(Uuid::new_v4()).unwrap_or_else(|error| panic!("{error}"));
        state.close();
        drop(current);
        assert!(state.begin(Uuid::new_v4()).is_err());
    }

    #[test]
    fn a_revoked_pending_selection_cannot_be_installed() {
        let state = Arc::new(Inner::default());
        let request = Uuid::new_v4();
        let lease = state.begin(request).unwrap();
        let mut lifecycle = state.lifecycle.lock().unwrap();
        lifecycle.revoke(Uuid::new_v4());
        assert_eq!(lifecycle.pending, Some(request));
        lifecycle.revoke(request);
        assert_eq!(lifecycle.pending, None);
        drop(lifecycle);
        assert!(state.begin(Uuid::new_v4()).is_err());
        drop(lease);
        assert!(state.begin(Uuid::new_v4()).is_ok());
    }

    #[test]
    fn chooses_only_from_bundled_app_document() {
        for trusted in ["http://tauri.localhost/", "https://tauri.localhost/index.html"] {
            assert!(bundled_origin(&tauri::Url::parse(trusted).unwrap()));
        }
        for unavailable in [
            "https://example.com/",
            "http://127.0.0.1:1420/",
            "https://tauri.localhost/other",
        ] {
            assert!(!bundled_origin(&tauri::Url::parse(unavailable).unwrap()));
        }
    }

}
