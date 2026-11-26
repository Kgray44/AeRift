#![cfg(target_os = "android")]

mod camera_commands;
mod discovery;
mod peer_storage;
mod storage;

pub use discovery::{start_discovery, stop_discovery, DiscoveryState, DiscoveryUpdate};
pub use peer_storage::open_peer_node;
pub use storage::{
    clipboard_image_available, import_media, list_media, open_browser, paste_clipboard_image,
    pick_file, present_selection, remove_media, stage_media, stage_text, storage_directories,
    thumbnail_media,
    BrowserLink, MediaAsset, PickerSource, SelectionAction, StagedSelection,
};

use serde::{de::DeserializeOwned, Serialize};
use tauri::{
    plugin::{mobile::PluginInvokeError, Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

struct AndroidPlatform<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("aerift-android")
        .invoke_handler(tauri::generate_handler![
            camera_commands::camera_permission,
            camera_commands::camera_clock,
            camera_commands::register_camera_events,
            camera_commands::start_camera,
            camera_commands::stop_camera,
        ])
        .setup(|app, api| {
            let native = api.register_android_plugin(
                "com.kgamazing44.aerift.plugin",
                "AeriftAndroidPlugin",
            )?;
            app.manage(AndroidPlatform(native));
            app.manage(camera_commands::CameraUi::default());
            Ok(())
        })
        .build()
}

async fn call<R: Runtime, T: DeserializeOwned>(
    app: &AppHandle<R>,
    command: &str,
    args: impl Serialize,
) -> Result<T, PluginInvokeError> {
    app.state::<AndroidPlatform<R>>()
        .0
        .run_mobile_plugin_async(command, args)
        .await
}

async fn call_empty<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    args: impl Serialize,
) -> Result<(), PluginInvokeError> {
    call::<_, serde_json::Value>(app, command, args).await.map(|_| ())
}
