//! CI-only native host. Receipt proves exact synthetic selection, never stores
//! or returns content, and is not packaged with AeRift.
use aerift_transfer::{
    ambient::{CaptureOrigin, RiftObjectKind},
    ambient_browser::{ExtensionOrigin, receive_one},
};
use std::io::{self, Read, Write};

fn main() -> io::Result<()> {
    let capture = option_env!("AERIFT_BROWSER_ALLOWED_ORIGIN").and_then(|allowed| {
        let reported = std::env::args().nth(1)?;
        let origin = ExtensionOrigin::authorize(allowed, &reported).ok()?;
        receive_one(&mut io::stdin().lock(), &origin).ok()
    });
    let captured = capture.is_some_and(|capture| {
        let [entry] = capture.entries() else {
            return false;
        };
        let mut bytes = Vec::new();
        capture.origin == CaptureOrigin::ExplicitSelection
            && capture.kind == RiftObjectKind::PlainText
            && entry.manifest().sha256.is_some()
            && entry.open_verified().is_ok_and(|reader| {
                reader.take(128).read_to_end(&mut bytes).is_ok()
                    && bytes == b"AeRift exact synthetic selection."
            })
    });
    let state = if captured { "captured" } else { "refused" };
    let receipt = format!(r#"{{"version":1,"status":"{state}"}}"#);
    let mut stdout = io::stdout().lock();
    stdout.write_all(&(receipt.len() as u32).to_ne_bytes())?;
    stdout.write_all(receipt.as_bytes())?;
    stdout.flush()
}
