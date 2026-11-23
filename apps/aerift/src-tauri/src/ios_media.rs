use std::sync::{Arc, Mutex, MutexGuard};

use aerift_transfer::{ErrorCode, TransferError};
use serde::Serialize;
use tauri_plugin_aerift_ios::{StagedKind, StagedSelection};
use uuid::Uuid;

const MAX_IMPORTS: usize = 24;
const MAX_BATCH: usize = 12;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaImport {
    pub id: Uuid,
    pub name: String,
    pub kind: StagedKind,
    pub size_bytes: u64,
}

struct ImportedMedia {
    media: MediaImport,
    staged: Arc<StagedSelection>,
}

#[derive(Default)]
pub(crate) struct MediaTray(Mutex<Vec<ImportedMedia>>);

impl MediaTray {
    fn lock(&self) -> Result<MutexGuard<'_, Vec<ImportedMedia>>, TransferError> {
        self.0.lock().map_err(|_| ErrorCode::InternalError.into())
    }

    pub fn picker_limit(&self) -> Result<usize, TransferError> {
        let remaining = MAX_IMPORTS.saturating_sub(self.lock()?.len());
        if remaining == 0 {
            return Err(ErrorCode::Conflict.into());
        }
        Ok(remaining.min(MAX_BATCH))
    }

    pub fn list(&self) -> Result<Vec<MediaImport>, TransferError> {
        Ok(self
            .lock()?
            .iter()
            .map(|entry| entry.media.clone())
            .collect())
    }

    pub fn append(&self, files: Vec<StagedSelection>) -> Result<Vec<MediaImport>, TransferError> {
        let mut entries = self.lock()?;
        if files.len() > MAX_BATCH || files.len() > MAX_IMPORTS.saturating_sub(entries.len()) {
            return Err(ErrorCode::Conflict.into());
        }
        entries.extend(files.into_iter().map(|staged| ImportedMedia {
            media: MediaImport {
                id: Uuid::new_v4(),
                name: staged.name.clone(),
                kind: staged.kind,
                size_bytes: staged.size_bytes,
            },
            staged: Arc::new(staged),
        }));
        Ok(entries.iter().map(|entry| entry.media.clone()).collect())
    }

    pub fn remove(&self, id: Uuid) -> Result<Vec<MediaImport>, TransferError> {
        let mut entries = self.lock()?;
        entries.retain(|entry| entry.media.id != id);
        Ok(entries.iter().map(|entry| entry.media.clone()).collect())
    }

    pub fn get(&self, id: Uuid) -> Result<Arc<StagedSelection>, TransferError> {
        self.lock()?
            .iter()
            .find(|entry| entry.media.id == id)
            .map(|entry| Arc::clone(&entry.staged))
            .ok_or_else(|| ErrorCode::InvalidRequest.into())
    }
}
