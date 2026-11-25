#[cfg(windows)]
fn main() {
    std::process::exit(aerift_app::run_private_remote_wan_qualification());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This native qualification entry is Windows-only.");
    std::process::exit(2);
}
