#[cfg(windows)]
mod protected_store;
#[cfg(windows)]
mod runtime;
#[cfg(windows)]
mod selection;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_aerift_ios::init());

    #[cfg(windows)]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(runtime::DesktopRuntime::default())
        .manage(selection::SelectionRegistry::default())
        .invoke_handler(tauri::generate_handler![
            windows::watch_app,
            windows::unwatch_app,
            windows::watch_file_selection,
            windows::select_app_file,
            windows::pair_app_peer,
            windows::transfer_app_file,
            windows::get_receive_folder,
            windows::choose_receive_folder
        ])
        .on_webview_event(windows::handle_webview_event);

    builder
        .build(tauri::generate_context!())
        .expect("failed to launch AeRift")
        .run(|_app, _event| {
            #[cfg(windows)]
            if matches!(_event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                _app.state::<runtime::DesktopRuntime>().shutdown();
            }
        });
}
