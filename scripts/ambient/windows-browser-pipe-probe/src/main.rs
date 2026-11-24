#[cfg(windows)]
mod windows;

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    if windows::run().is_err() {
        eprintln!("Browser pipe qualification failed; no payload logged");
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This offline qualification uses native Windows named pipes");
    std::process::exit(1);
}
