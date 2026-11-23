#![cfg(target_os = "ios")]

mod camera_commands;
mod discovery;
mod keychain;
mod peer_storage;

pub use discovery::{
    start_discovery, stop_discovery, BonjourEndpoint, BonjourPeer, BonjourState, BonjourUpdate,
};
pub use keychain::{IosKeychain, KeychainError};
pub use peer_storage::open_peer_node;
use serde::{Deserialize, Serialize};
use std::{fs, io, path::PathBuf};
use tauri::plugin::mobile::PluginInvokeError;
use tauri::{
    ipc::Channel,
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

tauri::ios_plugin_binding!(init_plugin_aerift_ios);

struct IosPlatform<R: Runtime>(PluginHandle<R>);

/// Owns a sandbox copy. Keep it alive while the selected file can be offered or
/// read by a transfer. Only the display name and size may cross the AppPort.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedSelection {
    path: PathBuf,
    pub name: String,
    pub size_bytes: u64,
}

impl StagedSelection {
    pub fn path(&self) -> &std::path::Path {
        &self.path
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
struct PickerResponse {
    selection: Option<StagedSelection>,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("aerift-ios")
        .invoke_handler(tauri::generate_handler![
            camera_commands::camera_authorized,
            camera_commands::camera_clock,
            camera_commands::register_camera_events,
            camera_commands::start_camera,
            camera_commands::stop_camera,
        ])
        .setup(|app, api| {
            let picker = api.register_ios_plugin(init_plugin_aerift_ios)?;
            app.manage(IosPlatform(picker));
            app.manage(camera_commands::CameraUi::default());
            Ok(())
        })
        .build()
}

/// Opens the native source chooser. Cancellation resolves to `Ok(None)`.
/// Call from an asynchronous app command triggered by the trusted UI.
pub async fn pick_file<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<StagedSelection>, PluginInvokeError> {
    let picker = app.state::<IosPlatform<R>>();
    let response: PickerResponse = picker.0.run_mobile_plugin_async("pickFile", ()).await?;
    Ok(response.selection)
}

#[derive(Deserialize, Serialize)]
pub struct HandLandmark {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub confidence: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandFrame {
    pub capture_ms: f64,
    pub width: u32,
    pub height: u32,
    pub hands: Vec<Vec<HandLandmark>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CameraState {
    Disabled,
    Requesting,
    Starting,
    Ready,
    Denied,
    Unavailable,
    Busy,
    Suspended,
    Error,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CameraUpdate {
    Frame {
        attempt_id: String,
        frame: HandFrame,
    },
    State {
        attempt_id: String,
        state: CameraState,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraStart<'a> {
    attempt_id: &'a str,
    events: &'a Channel<CameraUpdate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraStop<'a> {
    attempt_id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CameraClock {
    clock_ms: f64,
}

pub async fn hand_camera_clock<R: Runtime>(app: &AppHandle<R>) -> Result<f64, PluginInvokeError> {
    let clock: CameraClock = app
        .state::<IosPlatform<R>>()
        .0
        .run_mobile_plugin_async("cameraClock", ())
        .await?;
    Ok(clock.clock_ms)
}

#[derive(Deserialize)]
struct CameraAuthorization {
    authorized: bool,
}

async fn hand_camera_authorized<R: Runtime>(app: &AppHandle<R>) -> Result<bool, PluginInvokeError> {
    let status: CameraAuthorization = app
        .state::<IosPlatform<R>>()
        .0
        .run_mobile_plugin_async("cameraAuthorized", ())
        .await?;
    Ok(status.authorized)
}

/// Call only from an explicit foreground camera action. Reuse the app's
/// channel for new attempts and route state changes to the shared controller.
pub async fn start_hand_camera<R: Runtime>(
    app: &AppHandle<R>,
    attempt_id: &str,
    events: &Channel<CameraUpdate>,
) -> Result<(), PluginInvokeError> {
    app.state::<IosPlatform<R>>()
        .0
        .run_mobile_plugin_async("startCamera", CameraStart { attempt_id, events })
        .await
}

pub async fn stop_hand_camera<R: Runtime>(
    app: &AppHandle<R>,
    attempt_id: &str,
) -> Result<(), PluginInvokeError> {
    app.state::<IosPlatform<R>>()
        .0
        .run_mobile_plugin_async("stopCamera", CameraStop { attempt_id })
        .await
}

pub struct ReceiveDirectories {
    pub partials: PathBuf,
    pub published: PathBuf,
}

/// The Apple Files app exposes Documents. The receiver writes, verifies and
/// removes partial files in the private cache before publishing to Documents.
pub fn receive_directories<R: Runtime>(app: &AppHandle<R>) -> io::Result<ReceiveDirectories> {
    let partials = app
        .path()
        .app_cache_dir()
        .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "iOS cache directory unavailable"))?
        .join("IncomingPartials");
    let published = app
        .path()
        .document_dir()
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "iOS Documents directory unavailable",
            )
        })?
        .join("Received");
    fs::create_dir_all(&partials)?;
    fs::create_dir_all(&published)?;
    Ok(ReceiveDirectories {
        partials,
        published,
    })
}
