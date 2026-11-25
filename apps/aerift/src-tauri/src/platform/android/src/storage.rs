use std::{
    fs,
    path::{Path, PathBuf},
};

use aerift_transfer::{ErrorCode, TransferError};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use uuid::Uuid;

use crate::{call, call_empty};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PickerSource {
    Files,
    Photos,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum AssetKind {
    File,
    Photo,
    Video,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    id: Uuid,
    name: String,
    size_bytes: u64,
    kind: AssetKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSelection {
    path: PathBuf,
    name: String,
    size_bytes: u64,
    #[serde(rename = "kind")]
    _kind: AssetKind,
}

/// A validated app-owned staging copy. The webview only gets selection metadata.
pub struct StagedSelection {
    path: PathBuf,
    pub name: String,
    pub size_bytes: u64,
}

impl StagedSelection {
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn validate(selection: NativeSelection, root: &Path) -> Result<Self, TransferError> {
        let root = root.canonicalize().map_err(storage_failed)?;
        let physical_parent = selection.path.parent().ok_or(ErrorCode::StorageFailed)?;
        let metadata = fs::symlink_metadata(&selection.path).map_err(storage_failed)?;
        if !metadata.is_file() || !fs::symlink_metadata(physical_parent).map_err(storage_failed)?.is_dir() {
            return Err(ErrorCode::StorageFailed.into());
        }
        let path = selection.path.canonicalize().map_err(storage_failed)?;
        let parent = path.parent().ok_or(ErrorCode::StorageFailed)?;
        if parent.parent() != Some(root.as_path())
            || !parent.file_name().and_then(|s| s.to_str())
                .is_some_and(|name| Uuid::parse_str(name).is_ok())
        {
            // Never delete or expose a path outside the dedicated staging root.
            return Err(ErrorCode::StorageFailed.into());
        }
        let staged = Self { path, name: selection.name, size_bytes: selection.size_bytes };
        let verified = metadata.len() == staged.size_bytes
            && staged.size_bytes <= (1 << 53) - 1
            && !staged.name.trim().is_empty()
            && staged.name.len() <= 180
            && !staged.name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'));
        if !verified { return Err(ErrorCode::InvalidRequest.into()); }
        Ok(staged)
    }
}

impl Drop for StagedSelection {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        if let Some(directory) = self.path.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
}

#[derive(Deserialize)]
pub struct StorageDirectories {
    pub staging: PathBuf,
    pub published: PathBuf,
    pub partials: PathBuf,
}

#[derive(Deserialize)]
struct Picks {
    selections: Vec<NativeSelection>,
}

#[derive(Deserialize)]
struct Pick {
    selection: Option<NativeSelection>,
}

#[derive(Deserialize)]
struct MediaAssets {
    items: Vec<MediaAsset>,
}

#[derive(Deserialize)]
struct Clipboard {
    available: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectionAction {
    Preview,
    Export,
    Share,
}

fn storage_failed(_: impl std::fmt::Display) -> TransferError {
    ErrorCode::StorageFailed.into()
}

pub async fn storage_directories<R: Runtime>(app: &AppHandle<R>) -> Result<StorageDirectories, TransferError> {
    let dirs: StorageDirectories = call(app, "storageDirectories", ()).await.map_err(storage_failed)?;
    if !dirs.staging.is_absolute() || !dirs.published.is_absolute() || !dirs.partials.is_absolute() {
        return Err(ErrorCode::StorageFailed.into());
    }
    let published = dirs.published.canonicalize().map_err(storage_failed)?;
    let partials = dirs.partials.canonicalize().map_err(storage_failed)?;
    let staging = dirs.staging.canonicalize().map_err(storage_failed)?;
    if !published.is_dir() || !partials.is_dir() || !staging.is_dir()
        || published.parent() != partials.parent() || published == partials
        || staging.starts_with(&published) || staging.starts_with(&partials)
        || published.starts_with(&staging) || partials.starts_with(&staging)
    {
        return Err(ErrorCode::StorageFailed.into());
    }
    Ok(StorageDirectories { staging, published, partials })
}

async fn authorize_staged<R: Runtime>(app: &AppHandle<R>, selection: Option<NativeSelection>)
    -> Result<Option<StagedSelection>, TransferError>
{
    let Some(selection) = selection else { return Ok(None); };
    let dirs = storage_directories(app).await?;
    StagedSelection::validate(selection, &dirs.staging).map(Some)
}

pub async fn pick_file<R: Runtime>(app: &AppHandle<R>, source: Option<PickerSource>)
    -> Result<Option<StagedSelection>, TransferError>
{
    let picks: Picks = call(app, "pickFile", serde_json::json!({
        "source": source, "persist": false, "limit": 1
    })).await.map_err(storage_failed)?;
    if picks.selections.len() > 1 {
        let dirs = storage_directories(app).await?;
        for selection in picks.selections {
            // Valid copies are released as each guard goes out of scope.
            let _ = StagedSelection::validate(selection, &dirs.staging);
        }
        return Err(ErrorCode::InvalidRequest.into());
    }
    authorize_staged(app, picks.selections.into_iter().next()).await
}

pub async fn stage_text<R: Runtime>(app: &AppHandle<R>, text: &str, name: &str)
    -> Result<Option<StagedSelection>, TransferError>
{
    let picked: Pick = call(app, "stageText", serde_json::json!({ "text": text, "name": name }))
        .await.map_err(storage_failed)?;
    authorize_staged(app, picked.selection).await
}

pub async fn stage_media<R: Runtime>(app: &AppHandle<R>, asset_id: Uuid)
    -> Result<Option<StagedSelection>, TransferError>
{
    let picked: Pick = call(app, "stageMedia", serde_json::json!({ "assetId": asset_id }))
        .await.map_err(storage_failed)?;
    authorize_staged(app, picked.selection).await
}

pub async fn import_media<R: Runtime>(app: &AppHandle<R>, source: PickerSource)
    -> Result<Vec<MediaAsset>, TransferError>
{
    let value: MediaAssets = call(app, "importMedia", serde_json::json!({ "source": source }))
        .await.map_err(storage_failed)?;
    Ok(value.items)
}

pub async fn list_media<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<MediaAsset>, TransferError> {
    let value: MediaAssets = call(app, "listMedia", ()).await.map_err(storage_failed)?;
    Ok(value.items)
}

pub async fn thumbnail_media<R: Runtime>(
    app: &AppHandle<R>, asset_id: Uuid,
) -> Result<String, TransferError> {
    #[derive(Deserialize)]
    struct Thumbnail { jpeg: String }
    let value: Thumbnail = call(app, "thumbnailMedia", serde_json::json!({ "assetId": asset_id }))
        .await.map_err(storage_failed)?;
    Ok(value.jpeg)
}

pub async fn remove_media<R: Runtime>(app: &AppHandle<R>, asset_id: Uuid)
    -> Result<Vec<MediaAsset>, TransferError>
{
    let value: MediaAssets = call(app, "removeMedia", serde_json::json!({ "assetId": asset_id }))
        .await.map_err(storage_failed)?;
    Ok(value.items)
}

pub async fn clipboard_image_available<R: Runtime>(app: &AppHandle<R>) -> Result<bool, TransferError> {
    let capability: Clipboard = call(app, "clipboardImageAvailable", ()).await.map_err(storage_failed)?;
    Ok(capability.available)
}

pub async fn paste_clipboard_image<R: Runtime>(app: &AppHandle<R>)
    -> Result<Option<StagedSelection>, TransferError>
{
    let picked: Pick = call(app, "pasteClipboardImage", ()).await.map_err(storage_failed)?;
    authorize_staged(app, picked.selection).await
}

pub async fn present_selection<R: Runtime>(
    app: &AppHandle<R>, path: &Path, name: &str, action: SelectionAction,
) -> Result<(), TransferError> {
    call_empty(app, "presentSelection", serde_json::json!({ "path": path, "name": name, "action": action }))
        .await.map_err(storage_failed)
}

#[derive(Deserialize, Serialize)]
pub struct BrowserLink {
    pub url: String,
    pub title: Option<String>,
}

#[derive(Deserialize)]
struct BrowserResponse {
    #[serde(default)]
    links: Vec<BrowserLink>,
}

pub async fn open_browser<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<Vec<BrowserLink>, TransferError> {
    let value: BrowserResponse = call(app, "openBrowser", serde_json::json!({ "url": url }))
        .await.map_err(|_| ErrorCode::InvalidRequest)?;
    Ok(value.links)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validated_lease_removes_only_its_file_on_drop() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let directory = root.join(Uuid::new_v4().to_string());
        let copy = directory.join("stage");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&copy, b"test").unwrap();
        let lease = StagedSelection::validate(NativeSelection {
            path: copy.clone(), name: "test.txt".into(), size_bytes: 4, _kind: AssetKind::File,
        }, &root).unwrap();
        drop(lease);
        assert!(!copy.exists());
        assert!(!directory.exists());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn a_staged_symlink_does_not_remove_its_target() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        let directory = root.join(Uuid::new_v4().to_string());
        let target = root.join("protected");
        let fake = directory.join("fake");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&target, b"test").unwrap();
        std::os::unix::fs::symlink(&target, &fake).unwrap();
        assert!(StagedSelection::validate(NativeSelection {
            path: fake, name: "test.txt".into(), size_bytes: 4, _kind: AssetKind::File,
        }, &root).is_err());
        assert_eq!(fs::read(target).unwrap(), b"test");
        fs::remove_dir_all(root).unwrap();
    }
}
