use aerift_transfer::{ErrorCode, TransferError};
use std::sync::Arc;
use tauri::{ipc::Channel, DragDropEvent, Manager, Webview, WebviewEvent, Wry};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::{
    runtime::{
        AppSnapshot, DesktopRuntime, FolderView, PairRequest, PairResult, Session, TransferRequest,
        TransferView,
    },
    selection::{FileSelection, SelectionRegistry, SelectionUpdate},
    windows_storage::storage_failed,
};

async fn session(window: &tauri::WebviewWindow) -> Result<Arc<Session>, TransferError> {
    let root = window.path().app_local_data_dir().map_err(storage_failed)?;
    window.state::<DesktopRuntime>().session(root).await
}

#[tauri::command]
pub(crate) async fn watch_app(
    window: tauri::WebviewWindow,
    updates: Channel<AppSnapshot>,
) -> Result<Uuid, TransferError> {
    let session = session(&window).await?;
    window.state::<DesktopRuntime>().watch(session, updates)
}

#[tauri::command]
pub(crate) fn unwatch_app(window: tauri::WebviewWindow, subscription_id: Uuid) {
    window.state::<DesktopRuntime>().unwatch(subscription_id);
}

#[tauri::command]
pub(crate) fn watch_file_selection(
    registry: tauri::State<'_, SelectionRegistry>,
    updates: Channel<SelectionUpdate>,
) -> Result<(), TransferError> {
    registry.watch(updates)
}

#[tauri::command]
pub(crate) async fn select_app_file(
    window: tauri::WebviewWindow,
) -> Result<Option<FileSelection>, TransferError> {
    let revision = window.state::<SelectionRegistry>().begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = window
            .dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|_| ErrorCode::InvalidRequest)?;
        window
            .state::<SelectionRegistry>()
            .select(revision, &path, false)
    })
    .await
    .map_err(|_| ErrorCode::InternalError)?
}

#[tauri::command]
pub(crate) async fn pair_app_peer(
    window: tauri::WebviewWindow,
    request: PairRequest,
) -> Result<PairResult, TransferError> {
    session(&window).await?.pair(request).await
}

#[tauri::command]
pub(crate) async fn transfer_app_file(
    window: tauri::WebviewWindow,
    request: TransferRequest,
) -> Result<TransferView, TransferError> {
    let session = session(&window).await?;
    session
        .transfer(&window.state::<SelectionRegistry>(), request)
        .await
}

#[tauri::command]
pub(crate) async fn get_receive_folder(
    window: tauri::WebviewWindow,
) -> Result<FolderView, TransferError> {
    let root = window.path().app_local_data_dir().map_err(storage_failed)?;
    let active = window.state::<DesktopRuntime>().receive_directory();
    tauri::async_runtime::spawn_blocking(move || {
        crate::runtime::folder_view(&root, active.as_deref())
    })
    .await
    .map_err(|_| ErrorCode::InternalError)?
}

#[tauri::command]
pub(crate) async fn choose_receive_folder(
    window: tauri::WebviewWindow,
) -> Result<Option<FolderView>, TransferError> {
    let root = window.path().app_local_data_dir().map_err(storage_failed)?;
    let active = window.state::<DesktopRuntime>().receive_directory();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(folder) = window
            .dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = folder.into_path().map_err(|_| ErrorCode::InvalidRequest)?;
        crate::runtime::change_folder(&root, active.as_deref(), &path).map(Some)
    })
    .await
    .map_err(|_| ErrorCode::InternalError)?
}

pub(crate) fn handle_webview_event(webview: &Webview<Wry>, event: &WebviewEvent) {
    if webview.label() != "main" {
        return;
    }
    let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event else {
        return;
    };
    let registry = webview.state::<SelectionRegistry>();
    let Ok(revision) = registry.begin() else {
        return;
    };
    let [path] = paths.as_slice() else {
        registry.reject(revision, ErrorCode::InvalidRequest.into());
        return;
    };
    let path = path.clone();
    let handle = webview.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = handle
            .state::<SelectionRegistry>()
            .select(revision, &path, true);
    });
}
