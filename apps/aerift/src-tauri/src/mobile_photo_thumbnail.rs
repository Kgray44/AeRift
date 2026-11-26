use std::sync::atomic::{AtomicBool, Ordering};

use aerift_transfer::{ErrorCode, TransferError};
use tauri::WebviewWindow;

const LIMIT: usize = 128 * 1024;
static DECODING: AtomicBool = AtomicBool::new(false);

pub(crate) struct DecodePermit;
impl DecodePermit {
    pub(crate) fn acquire() -> Result<Self, TransferError> {
        DECODING
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| Self)
            .map_err(|_| ErrorCode::Conflict.into())
    }
}
impl Drop for DecodePermit {
    fn drop(&mut self) {
        DECODING.store(false, Ordering::Release);
    }
}

pub(crate) fn require_thumbnail_origin(window: &WebviewWindow) -> Result<(), TransferError> {
    if window.label() != "main" {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let url = window.url().map_err(|_| ErrorCode::InvalidRequest)?;
    if !matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "/" | "/index.html")
    {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(())
}

pub(crate) fn validate_thumbnail(jpeg: String) -> Result<String, TransferError> {
    let bytes = jpeg.as_bytes();
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if bytes.len() < 8
        || bytes.len() > LIMIT.div_ceil(3) * 4
        || bytes.len() % 4 != 0
        || padding > 2
        || bytes.len() / 4 * 3 - padding > LIMIT
        || !bytes.starts_with(b"/9j/")
        || !bytes[..bytes.len() - padding]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'+' | b'/'))
    {
        return Err(ErrorCode::InvalidRequest.into());
    }
    Ok(jpeg)
}
