#[cfg(any(windows, target_os = "ios", target_os = "android"))]
mod workspace_link;
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
#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
mod android_received;
#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod desktop_explorer;
#[cfg(windows)]
mod explorer_receive;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "ios")]
mod ios_received_preview;
#[cfg(any(target_os = "ios", target_os = "android"))]
mod mobile_photo_thumbnail;
#[cfg(windows)]
mod private_remote_app;
#[cfg(windows)]
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
mod windows_friends;
#[cfg(windows)]
mod windows_friends_member;
#[cfg(windows)]
mod windows_friends_files;
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
            ios::preview_ios_received_text,
            ios::list_ios_received_receipts,
            ios::configure_ios_receipt_history,
            ios::unwatch_app,
            ios::select_app_file,
            ios::import_ios_media,
            ios::list_ios_media,
            ios::thumbnail_ios_media,
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
            android::thumbnail_android_media,
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
        .manage(private_remote_app::RemoteRuntime::default())
        .manage(windows_friends::WindowsFriends::default())
        .manage(explorer_receive::ExplorerReceiveRuntime::default())
        .manage(windows_friends_member::MemberRuntime::default())
        .manage(windows_friends_member::ReviewRuntime::default())
        .manage(selection::SelectionRegistry::default())
        .invoke_handler(tauri::generate_handler![
            private_remote_app::windows_remote_mode,
            private_remote_app::windows_set_remote_mode,
            private_remote_app::windows_exit_for_remote_mode,
            private_remote_app::private_remote_snapshot,
            private_remote_app::private_remote_start,
            private_remote_app::private_remote_action,
            private_remote_app::windows_redeem_remote,
            private_remote_app::windows_send_remote_file,
            private_remote_app::folder_mode::windows_remote_folder_command,
            windows::watch_app,
            windows_friends::friends_setup_view,
            windows_friends_member::friends_member,
            windows_friends::friends_setup_card,
            windows_friends::friends_setup_issue,
            windows_friends::friends_setup_review,
            windows_friends::friends_setup_consent,
            windows_friends::friends_setup_finish,
            windows_friends::friends_setup_answer,
            windows_friends::friends_setup_contact,
            windows_friends_files::friends_files_view,
            windows_friends_files::friends_files_action,
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
            windows::list_ambient_inbox,
            windows::verify_ambient_inbox_entry,
            windows::preview_ambient_inbox_text,
            windows::save_ambient_inbox_entry,
            explorer_receive::arm_explorer_receive,
            explorer_receive::view_explorer_receive,
            explorer_receive::confirm_explorer_receive,
            explorer_receive::cancel_explorer_receive,
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
        .on_webview_event(|webview, event| {
            use tauri::Manager;
            if webview.state::<runtime::AppRuntime>().nearby_enabled() {
                windows::handle_webview_event(webview, event);
            }
        })
        .on_window_event(|window, event| {
            use tauri::Manager;
            if window.state::<runtime::AppRuntime>().nearby_enabled() {
                desktop::handle_window(window, event);
            }
        })
        .setup(|app| {
            use tauri::Manager;
            let remote = app.state::<private_remote_app::RemoteRuntime>();
            let mode = private_remote_app::load_mode(app.handle());
            let nearby = matches!(&mode, Ok(None));
            remote.configure(mode);
            app.state::<runtime::AppRuntime>().configure_nearby(nearby);
            if !nearby {
                return Ok(());
            }
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

