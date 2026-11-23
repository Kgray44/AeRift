use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use aerift_transfer::{ErrorCode, TransferError};
use serde::Serialize;
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
    path: PathBuf,
    dropped: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum SelectionUpdate {
    Dropped { selection: FileSelection },
    Rejected { error: TransferError },
}

#[derive(Default)]
struct State {
    selected: Option<SelectedFile>,
    watcher: Option<Channel<SelectionUpdate>>,
}

#[derive(Default)]
pub(crate) struct SelectionRegistry(Mutex<State>);

impl State {
    fn publish(&self, update: SelectionUpdate) {
        if let Some(watcher) = &self.watcher {
            let _ = watcher.send(update);
        }
    }
}

impl SelectionRegistry {
    pub(crate) fn watch(&self, updates: Channel<SelectionUpdate>) -> Result<(), TransferError> {
        let mut state = self.0.lock().map_err(|_| ErrorCode::InternalError)?;
        state.watcher = Some(updates);
        if let Some(entry) = state.selected.as_ref().filter(|entry| entry.dropped) {
            state.publish(SelectionUpdate::Dropped {
                selection: entry.details.clone(),
            });
        }
        Ok(())
    }

    pub(crate) fn select(
        &self,
        path: &Path,
        dropped: bool,
    ) -> Result<FileSelection, TransferError> {
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
        let details = FileSelection {
            selection_id: Uuid::new_v4().to_string(),
            name,
            size_bytes: metadata.len(),
        };
        let mut state = self.0.lock().map_err(|_| ErrorCode::InternalError)?;
        state.selected = Some(SelectedFile {
            details: details.clone(),
            path,
            dropped,
        });
        if dropped {
            state.publish(SelectionUpdate::Dropped {
                selection: details.clone(),
            });
        }
        Ok(details)
    }

    pub(crate) fn lookup(&self, selection_id: &str) -> Option<(FileSelection, PathBuf)> {
        let state = self.0.lock().ok()?;
        let entry = state.selected.as_ref()?;
        (entry.details.selection_id == selection_id)
            .then(|| (entry.details.clone(), entry.path.clone()))
    }

    pub(crate) fn consume(&self, selection_id: &str) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if state
            .selected
            .as_ref()
            .is_some_and(|file| file.details.selection_id == selection_id)
        {
            state.selected = None;
            return true;
        }
        false
    }

    pub(crate) fn reject(&self, error: TransferError) {
        if let Ok(state) = self.0.lock() {
            state.publish(SelectionUpdate::Rejected { error });
        }
    }
}
