#![cfg(target_os = "ios")]

use serde::Deserialize;
use std::{fs, path::PathBuf};
use tauri::plugin::mobile::PluginInvokeError;
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

tauri::ios_plugin_binding!(init_plugin_aerift_ios);

struct IosPicker<R: Runtime>(PluginHandle<R>);

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
            app.manage(IosPicker(picker));
            Ok(())
        })
        .build()
}

/// Opens the native source chooser. Cancellation resolves to `Ok(None)`.
/// Call from an asynchronous app command triggered by the trusted UI.
pub async fn pick_file<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<StagedSelection>, PluginInvokeError> {
    let picker = app.state::<IosPicker<R>>();
    let response: PickerResponse = picker.0.run_mobile_plugin_async("pickFile", ()).await?;
    Ok(response.selection)
}
