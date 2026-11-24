use std::sync::Arc;

use aerift_transfer::{ErrorCode, PeerId, TransferError};
use tauri::{ipc::Channel, Manager, WebviewWindow};
use tauri_plugin_aerift_android as platform;
use platform::{BrowserLink, MediaAsset, PickerSource, SelectionAction, StagedSelection};
use uuid::Uuid;

use crate::{
    android_received::{self, ReceivedFile},
    runtime::{AppRuntime, AppSnapshot, PairRequest, PairResult, Session, TransferRequest, TransferView},
    selection::{FileSelection, SelectionRegistry},
};

fn require_main(window: &WebviewWindow) -> Result<(), TransferError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(ErrorCode::InvalidRequest.into())
    }
}

async fn session(window: &WebviewWindow) -> Result<Arc<Session>, TransferError> {
    require_main(window)?;
    window.state::<AppRuntime>().android_session(window.app_handle()).await
}

#[tauri::command]
pub(crate) async fn watch_app(
    window: WebviewWindow,
    updates: Channel<AppSnapshot>,
) -> Result<Uuid, TransferError> {
    let session = session(&window).await?;
    window.state::<AppRuntime>().watch(session, updates)
}

#[tauri::command]
pub(crate) fn unwatch_app(window: WebviewWindow, subscription_id: Uuid) {
    if require_main(&window).is_ok() {
        window.state::<AppRuntime>().unwatch(subscription_id);
    }
}

#[tauri::command]
pub(crate) async fn retry_android_discovery(window: WebviewWindow) -> Result<(), TransferError> {
    session(&window).await?.retry_android_discovery(window.app_handle()).await
}

/// The revision is acquired before invoking the picker; cancellation preserves the
/// existing selection and a superseded picker can never replace a newer result.
async fn select(
    window: &WebviewWindow,
    acquire: impl std::future::Future<Output = Result<Option<StagedSelection>, TransferError>>,
) -> Result<Option<FileSelection>, TransferError> {
    require_main(window)?;
    let registry = window.state::<SelectionRegistry>();
    let revision = registry.begin()?;
    match acquire.await? {
        Some(staged) => registry.select_staged(revision, staged),
        None => Ok(None),
    }
}

#[tauri::command]
pub(crate) async fn select_app_file(
    window: WebviewWindow,
    source: Option<PickerSource>,
) -> Result<Option<FileSelection>, TransferError> {
    select(&window, platform::pick_file(window.app_handle(), source)).await
}

#[tauri::command]
pub(crate) fn clear_app_file(window: WebviewWindow, selection_id: String) -> Result<(), TransferError> {
    require_main(&window)?;
    window.state::<SelectionRegistry>().consume(&selection_id).map(|_| ())
}

#[tauri::command]
pub(crate) async fn set_receiver_ready(window: WebviewWindow, ready: bool) -> Result<u64, TransferError> {
    session(&window).await?.set_receiver_ready(ready)
}

#[tauri::command]
pub(crate) async fn check_receiver(window: WebviewWindow, device_id: PeerId) -> Result<bool, TransferError> {
    session(&window).await?.check_receiver(device_id).await
}

#[tauri::command]
pub(crate) async fn pair_app_peer(window: WebviewWindow, request: PairRequest) -> Result<PairResult, TransferError> {
    session(&window).await?.pair(request).await
}

#[tauri::command]
pub(crate) async fn transfer_app_file(window: WebviewWindow, request: TransferRequest) -> Result<TransferView, TransferError> {
    session(&window).await?.transfer(&window.state::<SelectionRegistry>(), request).await
}

#[tauri::command]
pub(crate) async fn import_android_media(window: WebviewWindow, source: PickerSource) -> Result<Vec<MediaAsset>, TransferError> {
    require_main(&window)?;
    platform::import_media(window.app_handle(), source).await
}

#[tauri::command]
pub(crate) async fn list_android_media(window: WebviewWindow) -> Result<Vec<MediaAsset>, TransferError> {
    require_main(&window)?;
    platform::list_media(window.app_handle()).await
}

#[tauri::command]
pub(crate) async fn remove_android_media(window: WebviewWindow, asset_id: Uuid) -> Result<Vec<MediaAsset>, TransferError> {
    require_main(&window)?;
    platform::remove_media(window.app_handle(), asset_id).await
}

#[tauri::command]
pub(crate) async fn select_android_media(window: WebviewWindow, asset_id: Uuid) -> Result<Option<FileSelection>, TransferError> {
    select(&window, platform::stage_media(window.app_handle(), asset_id)).await
}

#[tauri::command]
pub(crate) async fn present_android_media(
    window: WebviewWindow,
    asset_id: Uuid,
    action: SelectionAction,
) -> Result<(), TransferError> {
    require_main(&window)?;
    let staged = platform::stage_media(window.app_handle(), asset_id).await?
        .ok_or(ErrorCode::StorageFailed)?;
    platform::present_selection(window.app_handle(), staged.path(), &staged.name, action).await
}

#[tauri::command]
pub(crate) async fn stage_android_text(
    window: WebviewWindow,
    text: String,
    name: String,
) -> Result<Option<FileSelection>, TransferError> {
    if text.is_empty() || text.len() > 128 * 1024 || name.trim().is_empty() || name.len() > 180
        || name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
    {
        return Err(ErrorCode::InvalidRequest.into());
    }
    select(&window, platform::stage_text(window.app_handle(), &text, &name)).await
}

#[tauri::command]
pub(crate) async fn android_clipboard_image_available(window: WebviewWindow) -> Result<bool, TransferError> {
    require_main(&window)?;
    platform::clipboard_image_available(window.app_handle()).await
}

#[tauri::command]
pub(crate) async fn stage_android_clipboard_image(window: WebviewWindow) -> Result<Option<FileSelection>, TransferError> {
    select(&window, platform::paste_clipboard_image(window.app_handle())).await
}

#[tauri::command]
pub(crate) async fn present_android_selection(
    window: WebviewWindow,
    selection_id: String,
    action: SelectionAction,
) -> Result<(), TransferError> {
    require_main(&window)?;
    let (details, source) = window.state::<SelectionRegistry>().lookup(&selection_id)
        .ok_or(ErrorCode::InvalidRequest)?;
    // The shared source lease remains held until preview/export preparation returns.
    platform::present_selection(window.app_handle(), source.staged_selection().path(), &details.name, action).await
}

#[tauri::command]
pub(crate) async fn list_android_received(
    window: WebviewWindow,
) -> Result<Vec<ReceivedFile>, TransferError> {
    require_main(&window)?;
    // Local verified files remain accessible even if discovery or Keystore is unavailable.
    let root = platform::storage_directories(window.app_handle()).await?.published;
    tauri::async_runtime::spawn_blocking(move || android_received::list(&root))
        .await
        .map_err(|_| ErrorCode::InternalError)?
}

#[tauri::command]
pub(crate) async fn present_android_received(
    window: WebviewWindow,
    transfer_id: String,
    action: SelectionAction,
) -> Result<(), TransferError> {
    require_main(&window)?;
    let (path, name) = if transfer_id.starts_with(android_received::ID_PREFIX) {
        let root = platform::storage_directories(window.app_handle()).await?.published;
        tauri::async_runtime::spawn_blocking(move || android_received::resolve(&root, &transfer_id))
            .await
            .map_err(|_| ErrorCode::InternalError)??
    } else {
        session(&window).await?.android_received(&transfer_id)?
    };
    platform::present_selection(window.app_handle(), &path, &name, action).await
}

#[tauri::command]
pub(crate) async fn open_android_browser(window: WebviewWindow, url: String) -> Result<Vec<BrowserLink>, TransferError> {
    require_main(&window)?;
    let url = crate::workspace_link::browser_destination(&url).ok_or(ErrorCode::InvalidRequest)?;
    let links = platform::open_browser(window.app_handle(), url.as_str()).await?;
    Ok(links.into_iter().take(32).filter_map(|item| {
        let url = crate::workspace_link::browser_destination(&item.url)?;
        let title = item.title.filter(|title| title.len() <= 180 && !title.chars().any(char::is_control));
        Some(BrowserLink { url: url.into(), title })
    }).collect())
}
