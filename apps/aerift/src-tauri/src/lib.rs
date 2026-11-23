#[cfg(target_os = "ios")]
mod ios;
#[cfg(windows)]
mod protected_store;
#[cfg(any(windows, target_os = "ios"))]
mod runtime;
#[cfg(any(windows, target_os = "ios"))]
mod selection;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(target_os = "ios")]
    let builder = builder
        .plugin(tauri_plugin_aerift_ios::init())
        .manage(runtime::AppRuntime::default())
        .manage(selection::SelectionRegistry::default())
        .invoke_handler(tauri::generate_handler![
            ios::watch_app,
            ios::unwatch_app,
            ios::select_app_file,
            ios::stage_ios_text,
            ios::present_ios_selection,
            ios::open_ios_browser,
            ios::clear_app_file,
            ios::set_receiver_ready,
            ios::check_receiver,
            ios::pair_app_peer,
            ios::transfer_app_file,
            ios::retry_ios_discovery,
        ]);

    #[cfg(windows)]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(runtime::AppRuntime::default())
        .manage(selection::SelectionRegistry::default())
        .invoke_handler(tauri::generate_handler![
            windows::watch_app,
            windows::unwatch_app,
            windows::watch_file_selection,
            windows::select_app_file,
            windows::clear_app_file,
            windows::set_receiver_ready,
            windows::check_receiver,
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
            #[cfg(any(windows, target_os = "ios"))]
            if matches!(_event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                _app.state::<runtime::AppRuntime>().shutdown();
            }
        });
}
