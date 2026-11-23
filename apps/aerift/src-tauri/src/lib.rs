#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod desktop_explorer;
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
            ios::clear_app_file,
            ios::set_receiver_ready,
            ios::check_receiver,
            ios::pair_app_peer,
            ios::transfer_app_file,
            ios::retry_ios_discovery,
        ]);

    #[cfg(windows)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(
            desktop_explorer::on_second_instance,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| desktop::handle_shortcut(app, event.state()))
                .build(),
        )
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
            windows::choose_receive_folder,
            desktop::watch_desktop_ambient,
            desktop::set_desktop_ambient,
            desktop::update_desktop_ambient,
            desktop::set_desktop_shortcut,
            desktop::desktop_startup_enabled,
            desktop::set_desktop_startup,
            desktop::open_workspace_url,
            desktop::desktop_transfer_preview,
            desktop::notify_desktop_incoming,
            desktop_explorer::desktop_explorer_enabled,
            desktop_explorer::set_desktop_explorer,
        ])
        .on_webview_event(windows::handle_webview_event)
        .on_window_event(desktop::handle_window)
        .setup(|app| {
            let args = std::env::args_os().skip(1).collect::<Vec<_>>();
            desktop_explorer::stage_launch_file(
                app.handle(),
                &args,
                std::env::current_dir().ok().as_deref(),
            );
            if let Err(error) = desktop::install_tray(app) {
                eprintln!("AeRift notification area unavailable: {error}");
            }
            Ok(())
        });

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
