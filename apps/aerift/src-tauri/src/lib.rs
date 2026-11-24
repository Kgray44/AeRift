#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
mod android_received;
#[cfg(windows)]
mod ambient_context;
#[cfg(all(windows, feature = "ambient-media-qualification"))]
#[allow(dead_code)]
mod ambient_media_foundation;
#[cfg(all(
    windows,
    target_arch = "x86_64",
    feature = "ambient-native-model-qualification"
))]
#[allow(dead_code)]
mod ambient_native_model;
#[cfg(windows)]
mod ambient_runtime;
#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod desktop_explorer;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(all(windows, feature = "private-remote-app"))]
mod private_remote_app;
#[cfg(all(windows, feature = "private-remote-app"))]
mod private_remote_profile;
#[cfg(windows)]
mod protected_store;
#[cfg(any(windows, target_os = "ios", target_os = "android"))]
mod runtime;
#[cfg(any(windows, target_os = "ios", target_os = "android"))]
mod selection;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        if args.iter().any(|arg| arg == "--private-remote-dev") {
            #[cfg(feature = "private-remote-app")]
            match private_remote_app::launch_endpoint(args) {
                Ok(Some(endpoint)) => {
                    private_remote_app::run(endpoint, tauri::generate_context!());
                }
                _ => eprintln!("Invalid private Remote developer launch. No listener was started."),
            }
            #[cfg(not(feature = "private-remote-app"))]
            eprintln!("Private Remote developer feature is not included. No listener was started.");
            return;
        }
    }
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
            ios::import_ios_media,
            ios::list_ios_media,
            ios::remove_ios_media,
            ios::select_ios_media,
            ios::present_ios_media,
            ios::stage_ios_text,
            ios::ios_clipboard_image_available,
            ios::stage_ios_clipboard_image,
            ios::present_ios_selection,
            ios::open_ios_browser,
            ios::clear_app_file,
            ios::set_receiver_ready,
            ios::check_receiver,
            ios::pair_app_peer,
            ios::transfer_app_file,
            ios::retry_ios_discovery,
        ]);

    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_aerift_android::init())
        .manage(runtime::AppRuntime::default())
        .manage(selection::SelectionRegistry::default())
        .invoke_handler(tauri::generate_handler![
            android::watch_app,
            android::unwatch_app,
            android::select_app_file,
            android::clear_app_file,
            android::set_receiver_ready,
            android::check_receiver,
            android::pair_app_peer,
            android::transfer_app_file,
            android::retry_android_discovery,
            android::import_android_media,
            android::list_android_media,
            android::remove_android_media,
            android::select_android_media,
            android::present_android_media,
            android::stage_android_text,
            android::android_clipboard_image_available,
            android::stage_android_clipboard_image,
            android::present_android_selection,
            android::list_android_received,
            android::present_android_received,
            android::open_android_browser,
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
                .with_handler(|app, key, event| desktop::handle_shortcut(app, key, event.state()))
                .build(),
        )
        .manage(runtime::AppRuntime::default())
        .manage(ambient_runtime::AmbientRuntime::default())
        .manage(selection::SelectionRegistry::default())
        .invoke_handler(tauri::generate_handler![
            windows::watch_app,
            ambient_runtime::watch_ambient_capture,
            ambient_runtime::set_ambient_capture,
            ambient_runtime::send_ambient_file,
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
            use tauri::Manager;
            app.state::<ambient_runtime::AmbientRuntime>()
                .start_lifecycle_watch();
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
            #[cfg(any(windows, target_os = "ios", target_os = "android"))]
            if matches!(_event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                _app.state::<runtime::AppRuntime>().shutdown();
            }
        });
}
