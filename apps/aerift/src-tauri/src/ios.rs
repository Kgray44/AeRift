use std::sync::Arc;

use aerift_transfer::{ErrorCode, TransferError};
use tauri::{ipc::Channel, Manager, WebviewWindow};
use uuid::Uuid;

use crate::{
    runtime::{
        AppRuntime, AppSnapshot, PairRequest, PairResult, Session, TransferRequest, TransferView,
    },
    selection::{FileSelection, SelectionRegistry},
};

async fn session(window: &WebviewWindow) -> Result<Arc<Session>, TransferError> {
    if window.label() != "main" {
        return Err(ErrorCode::InvalidRequest.into());
    }
    window
        .state::<AppRuntime>()
        .ios_session(window.app_handle())
        .await
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
    if window.label() == "main" {
        window.state::<AppRuntime>().unwatch(subscription_id);
    }
}

#[tauri::command]
pub(crate) async fn retry_ios_discovery(window: WebviewWindow) -> Result<(), TransferError> {
    session(&window)
        .await?
        .retry_discovery(window.app_handle())
        .await
}

#[tauri::command]
pub(crate) async fn select_app_file(
    window: WebviewWindow,
    source: Option<tauri_plugin_aerift_ios::PickerSource>,
) -> Result<Option<FileSelection>, TransferError> {
    if window.label() != "main" {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let registry = window.state::<SelectionRegistry>();
    let revision = registry.begin()?;
    match tauri_plugin_aerift_ios::pick_file(window.app_handle(), source).await {
        Ok(Some(staged)) => registry.select_staged(revision, staged),
        Ok(None) => Ok(None),
        Err(_) => Err(ErrorCode::StorageFailed.into()),
    }
}

#[tauri::command]
pub(crate) async fn stage_ios_text(
    window: WebviewWindow,
    text: String,
    name: String,
) -> Result<Option<FileSelection>, TransferError> {
    if window.label() != "main" || text.is_empty() || text.len() > 128 * 1024 || name.len() > 180 {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let registry = window.state::<SelectionRegistry>();
    let revision = registry.begin()?;
    match tauri_plugin_aerift_ios::stage_text(window.app_handle(), &text, &name).await {
        Ok(Some(staged)) => registry.select_staged(revision, staged),
        Ok(None) => Ok(None),
        Err(_) => Err(ErrorCode::StorageFailed.into()),
    }
}

#[tauri::command]
pub(crate) async fn open_ios_browser(
    window: WebviewWindow,
    url: String,
) -> Result<(), TransferError> {
    if window.label() != "main" || url.len() > 4096 {
        return Err(ErrorCode::InvalidRequest.into());
    }
    tauri_plugin_aerift_ios::open_browser(window.app_handle(), &url)
        .await
        .map_err(|_| ErrorCode::InvalidRequest.into())
}

#[tauri::command]
pub(crate) async fn pair_app_peer(
    window: WebviewWindow,
    request: PairRequest,
) -> Result<PairResult, TransferError> {
    session(&window).await?.pair(request).await
}

#[tauri::command]
pub(crate) async fn transfer_app_file(
    window: WebviewWindow,
    request: TransferRequest,
) -> Result<TransferView, TransferError> {
    let session = session(&window).await?;
    session
        .transfer(&window.state::<SelectionRegistry>(), request)
        .await
}
