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
        return Err(ErrorCode::PermissionDenied.into());
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
) -> Result<Option<FileSelection>, TransferError> {
    if window.label() != "main" {
        return Err(ErrorCode::PermissionDenied.into());
    }
    let registry = window.state::<SelectionRegistry>();
    let revision = registry.begin()?;
    match tauri_plugin_aerift_ios::pick_file(window.app_handle()).await {
        Ok(Some(staged)) => registry.select_staged(revision, staged),
        Ok(None) => Ok(None),
        Err(_) => Err(ErrorCode::StorageFailed.into()),
    }
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
