use std::{path::PathBuf, sync::Mutex};

#[cfg(any(target_os = "ios", target_os = "android"))]
use std::sync::Arc;
#[cfg(windows)]
use std::{fs, path::Path};
#[cfg(target_os = "android")]
use tauri_plugin_aerift_android::StagedSelection;
#[cfg(target_os = "ios")]
use tauri_plugin_aerift_ios::StagedSelection;

use aerift_transfer::{ErrorCode, TransferError};
use serde::Serialize;
#[cfg(windows)]
use tauri::ipc::Channel;
use uuid::Uuid;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileSelection {
    pub(crate) selection_id: String,
    pub(crate) name: String,
    size_bytes: u64,
}

struct SelectedFile {
    details: FileSelection,
    source: SelectionSource,
}

#[derive(Clone)]
pub(crate) struct SelectionSource {
    pub(crate) path: PathBuf,
    #[cfg(any(target_os = "ios", target_os = "android"))]
    _staging: Arc<StagedSelection>,
}

#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum SelectionUpdate {
    Changed { selection: Option<FileSelection> },
    Rejected { error: TransferError },
}

#[derive(Default)]
struct State {
    revision: u64,
    selected: Option<SelectedFile>,
    #[cfg(windows)]
    watcher: Option<Channel<SelectionUpdate>>,
}

#[derive(Default)]
pub(crate) struct SelectionRegistry(Mutex<State>);

#[cfg(windows)]
impl State {
    fn publish_selection(&self) {
        self.publish(SelectionUpdate::Changed {
            selection: self.selected.as_ref().map(|entry| entry.details.clone()),
        });
    }

    fn publish(&self, update: SelectionUpdate) {
        if let Some(watcher) = &self.watcher {
            let _ = watcher.send(update);
        }
    }
}

#[cfg(any(target_os = "ios", target_os = "android"))]
impl SelectionSource {
    pub(crate) fn staged_selection(&self) -> &StagedSelection {
        &self._staging
    }
}

impl SelectionRegistry {
    #[cfg(windows)]
    pub(crate) fn watch(&self, updates: Channel<SelectionUpdate>) -> Result<(), TransferError> {
        let mut state = self.0.lock().map_err(|_| ErrorCode::InternalError)?;
        state.watcher = Some(updates);
        state.publish_selection();
        Ok(())
    }

    pub(crate) fn begin(&self) -> Result<u64, TransferError> {
        let mut state = self.0.lock().map_err(|_| ErrorCode::InternalError)?;
        state.revision = state
            .revision
            .checked_add(1)
            .ok_or(ErrorCode::InternalError)?;
        Ok(state.revision)
    }

    #[cfg(windows)]
    pub(crate) fn select(
        &self,
        revision: u64,
        path: &Path,
        dropped: bool,
    ) -> Result<Option<FileSelection>, TransferError> {
        let prepared = SelectedFile::prepare(path);
        let mut state = self.0.lock().map_err(|_| ErrorCode::InternalError)?;
        if revision != state.revision {
            return Ok(None);
        }
        let selected = match prepared {
            Ok(selected) => selected,
            Err(error) if dropped => {
                state.publish(SelectionUpdate::Rejected { error });
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let details = selected.details.clone();
        state.selected = Some(selected);
        state.publish_selection();
        Ok(Some(details))
    }

    #[cfg(any(target_os = "ios", target_os = "android"))]
    pub(crate) fn select_staged(
        &self,
        revision: u64,
        staged: StagedSelection,
    ) -> Result<Option<FileSelection>, TransferError> {
        self.select_shared_staged(revision, Arc::new(staged))
    }

    #[cfg(any(target_os = "ios", target_os = "android"))]
    pub(crate) fn select_shared_staged(
        &self,
        revision: u64,
        staged: Arc<StagedSelection>,
    ) -> Result<Option<FileSelection>, TransferError> {
        if staged.size_bytes > (1 << 53) - 1 {
            return Err(ErrorCode::InvalidRequest.into());
        }
        let mut state = self.0.lock().map_err(|_| ErrorCode::InternalError)?;
        if revision != state.revision {
            return Ok(None);
        }
        let details = FileSelection {
            selection_id: Uuid::new_v4().to_string(),
            name: staged.name.clone(),
            size_bytes: staged.size_bytes,
        };
        state.selected = Some(SelectedFile {
            details: details.clone(),
            source: SelectionSource {
                path: staged.path().to_owned(),
                _staging: staged,
            },
        });
        Ok(Some(details))
    }

    pub(crate) fn lookup(&self, selection_id: &str) -> Option<(FileSelection, SelectionSource)> {
        let state = self.0.lock().ok()?;
        let entry = state.selected.as_ref()?;
        (entry.details.selection_id == selection_id)
            .then(|| (entry.details.clone(), entry.source.clone()))
    }

    pub(crate) fn consume(&self, selection_id: &str) -> Result<bool, TransferError> {
        let mut state = self.0.lock().map_err(|_| ErrorCode::InternalError)?;
        if state
            .selected
            .as_ref()
            .is_some_and(|file| file.details.selection_id == selection_id)
        {
            state.selected = None;
            #[cfg(windows)]
            state.publish_selection();
            return Ok(true);
        }
        Ok(false)
    }

    #[cfg(windows)]
    pub(crate) fn reject(&self, revision: u64, error: TransferError) {
        let Ok(state) = self.0.lock() else {
            return;
        };
        if revision == state.revision {
            state.publish(SelectionUpdate::Rejected { error });
        }
    }
}

#[cfg(windows)]
impl SelectedFile {
    fn prepare(path: &Path) -> Result<Self, TransferError> {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(ErrorCode::InvalidRequest)?
            .to_owned();
        let path = fs::canonicalize(path).map_err(|_| ErrorCode::StorageFailed)?;
        let metadata = fs::metadata(&path).map_err(|_| ErrorCode::StorageFailed)?;
        if !metadata.is_file() || metadata.len() > (1 << 53) - 1 {
            return Err(ErrorCode::InvalidRequest.into());
        }
        Ok(Self {
            details: FileSelection {
                selection_id: Uuid::new_v4().to_string(),
                name,
                size_bytes: metadata.len(),
            },
            source: SelectionSource { path },
        })
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tauri::ipc::InvokeResponseBody;

    fn assert_latest_selection(older_drop: bool, newer_drop: bool) {
        let folder = tempfile::tempdir().unwrap();
        let older_path = folder.path().join("older.bin");
        let newer_path = folder.path().join("newer.bin");
        fs::write(&older_path, b"older contents").unwrap();
        fs::write(&newer_path, b"newer contents").unwrap();

        let registry = SelectionRegistry::default();
        let updates = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&updates);
        registry
            .watch(Channel::new(move |payload| {
                let InvokeResponseBody::Json(json) = payload else {
                    panic!("expected a JSON selection update");
                };
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str::<serde_json::Value>(&json).unwrap());
                Ok(())
            }))
            .unwrap();
        updates.lock().unwrap().clear();

        let older = registry.begin().unwrap();
        let newer = registry.begin().unwrap();
        let latest = registry
            .select(newer, &newer_path, newer_drop)
            .unwrap()
            .unwrap();
        let stale = registry.select(older, &older_path, older_drop).unwrap();
        assert!(
            stale.is_none(),
            "older completion replaced the current file"
        );
        assert!(registry.lookup(&latest.selection_id).is_some());
        let updates = updates.lock().unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0]["selection"]["name"], "newer.bin");
    }

    #[test]
    fn a_newer_drop_supersedes_an_older_picker() {
        assert_latest_selection(false, true);
    }

    #[test]
    fn a_newer_picker_supersedes_an_older_drop() {
        assert_latest_selection(true, false);
    }

    #[test]
    fn reverse_drop_completion_preserves_the_newest_drop() {
        assert_latest_selection(true, true);
    }

    #[test]
    fn clearing_a_stale_id_keeps_the_replacement_and_clearing_the_current_id_publishes() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("selection.bin");
        fs::write(&path, b"keep the original file").unwrap();
        let registry = SelectionRegistry::default();
        let latest_update = Arc::new(Mutex::new(None));
        let captured = Arc::clone(&latest_update);
        registry
            .watch(Channel::new(move |payload| {
                let InvokeResponseBody::Json(json) = payload else {
                    panic!("expected JSON")
                };
                *captured.lock().unwrap() =
                    Some(serde_json::from_str::<serde_json::Value>(&json).unwrap());
                Ok(())
            }))
            .unwrap();
        let previous = registry
            .select(registry.begin().unwrap(), &path, false)
            .unwrap()
            .unwrap();
        let current = registry
            .select(registry.begin().unwrap(), &path, false)
            .unwrap()
            .unwrap();
        assert!(!registry.consume(&previous.selection_id).unwrap());
        assert!(registry.lookup(&current.selection_id).is_some());
        assert!(registry.consume(&current.selection_id).unwrap());
        assert!(latest_update.lock().unwrap().as_ref().unwrap()["selection"].is_null());
        assert_eq!(fs::read(&path).unwrap(), b"keep the original file");
    }
}
