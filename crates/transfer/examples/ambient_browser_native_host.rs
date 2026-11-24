//! Opt-in qualification host: validates and freezes one object, then discards it.
//! There is no app registration, storage, transfer routing or trusted same-user IPC.
use aerift_transfer::ambient_browser::{ExtensionOrigin, receive_one};
use std::io::{self, Write};

fn main() -> io::Result<()> {
    let status = option_env!("AERIFT_BROWSER_ALLOWED_ORIGIN")
        .and_then(|allowed| {
            let reported = std::env::args().nth(1)?;
            ExtensionOrigin::authorize(allowed, &reported).ok()
        })
        .and_then(|origin| receive_one(&mut io::stdin().lock(), &origin).ok())
        .map_or("refused", |_| "captured");

    let response = format!(r#"{{"version":1,"status":"{status}"}}"#);
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    stdout.write_all(&(response.len() as u32).to_ne_bytes())?;
    stdout.write_all(response.as_bytes())?;
    stdout.flush()
}
