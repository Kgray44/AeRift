#[cfg(all(windows, target_arch = "x86_64"))]
#[path = "../../../../apps/aerift/src-tauri/src/ambient_native_model.rs"]
mod ambient_native_model;

#[cfg(all(windows, target_arch = "x86_64"))]
fn main() {
    use aerift_transfer::ambient_camera::{RgbFrame, RgbLandmarker};
    use ambient_native_model::VerifiedWindowsLandmarker;
    use sha2::{Digest, Sha256};
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };

    let root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .expect("pass the staged bundle directory");
    let root = root.canonicalize().expect("bundle must exist");
    let reject = std::env::args_os()
        .nth(2)
        .is_some_and(|mode| mode == "--must-refuse");
    if reject {
        assert_eq!(
            VerifiedWindowsLandmarker::new(root).preflight(),
            Err(aerift_transfer::ambient_camera::CameraIssue::ModelUnavailable)
        );
        println!("Corrupted package rejected before loading a native module.");
        return;
    }
    let fixture_bytes = [0u8; 256 * 256 * 4];
    let fixture = RgbFrame::from_mf_rgb32(Instant::now(), 256, 256, -1024, &fixture_bytes).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(fixture.rgb())),
        "3381de4ca9f3a477f25989dfc8b744e7916046b7aa369f61a9a2f7dc0963ec9e"
    );
    let mut runtime = VerifiedWindowsLandmarker::new(root);
    runtime
        .preflight()
        .expect("pinned Windows x64 model/DLL should initialize");
    let hands = runtime
        .recognize(&fixture, Duration::from_secs(10))
        .expect("Windows C ABI invocation should succeed");
    assert!(
        hands.is_none(),
        "blank fixture unexpectedly detected a hand"
    );
    println!(
        "Rust native Windows model provider: pinned synthetic RGB yielded zero hands; no camera opened."
    );
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
fn main() {
    eprintln!("The native model probe requires Windows x64.");
    std::process::exit(2);
}
