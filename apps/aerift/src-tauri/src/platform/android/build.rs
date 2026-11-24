const COMMANDS: &[&str] = &[
    "camera_permission",
    "camera_clock",
    "register_camera_events",
    "start_camera",
    "stop_camera",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
