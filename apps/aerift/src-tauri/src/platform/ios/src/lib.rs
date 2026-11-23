#![cfg(target_os = "ios")]

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
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
        .setup(|app, api| {
            let picker = api.register_ios_plugin(init_plugin_aerift_ios)?;
            app.manage(IosPlatform(picker));
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
    pub confidence: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandFrame {
    pub timestamp_ms: f64,
    pub frame_width: u32,
    pub frame_height: u32,
    pub hands: Vec<Vec<HandLandmark>>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CameraUpdate {
    Frame { frame: HandFrame },
    Stopped { reason: Option<String> },
}

#[derive(Serialize)]
struct CameraStart<'a> {
    events: &'a Channel<CameraUpdate>,
}

/// Call only from an explicit foreground camera action. Reuse the session's
/// channel for restarts and reset the shared intent on any stop or stream gap.
pub async fn start_hand_camera<R: Runtime>(
    app: &AppHandle<R>,
    events: &Channel<CameraUpdate>,
) -> Result<(), PluginInvokeError> {
    app.state::<IosPlatform<R>>()
        .0
        .run_mobile_plugin_async("startCamera", CameraStart { events })
        .await
}

pub async fn stop_hand_camera<R: Runtime>(app: &AppHandle<R>) -> Result<(), PluginInvokeError> {
    app.state::<IosPlatform<R>>()
        .0
        .run_mobile_plugin_async("stopCamera", ())
        .await
}
