#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_aerift_ios::init());

    builder
        .run(tauri::generate_context!())
        .expect("failed to launch AeRift");
}
