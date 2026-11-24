//! One-shot native messaging intake; intentionally has no storage, activation,
//! shell, network, destination or transfer API. Browser host registration
//! enforces the origin allowlist before a message is delivered to this reader.

use crate::ambient::{
    Candidate, CaptureContext, CaptureLimits, FrozenCapture, RiftObjectKind, SourceApplication,
    freeze,
};
use serde::Deserialize;
use std::io::Read;

pub const HOST_NAME: &str = "com.aerift.ambient_browser";
pub const MAX_MESSAGE_BYTES: usize = 100 * 1024; // worst JSON escaping of a 16 KiB selection
const MAX_SELECTION_BYTES: usize = 16 * 1024;
const MAX_URL_BYTES: usize = 2048;

#[derive(Debug, Eq, PartialEq)]
pub enum IntakeError {
    Origin,
    Frame,
    Schema,
    Unsupported,
    Capture,
}

/// Credential for intake on the *browser-delivered* stdio channel. Arguments
/// from directly launched same-user processes are not a separate trust boundary.
pub struct ExtensionOrigin(());

impl ExtensionOrigin {
    pub fn authorize(allowed: &str, reported: &str) -> Result<Self, IntakeError> {
        fn chromium_id(origin: &str) -> Option<&str> {
            origin
                .strip_prefix("chrome-extension://")?
                .strip_suffix('/')
                .filter(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
        }
        match (chromium_id(allowed), chromium_id(reported)) {
            (Some(expected), Some(actual)) if expected == actual => Ok(Self(())),
            _ => Err(IntakeError::Origin),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Selection,
    Target,
    Media,
    Page,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Message {
    version: u8,
    kind: Kind,
    value: String,
}

pub fn receive_one(
    input: &mut impl Read,
    _origin: &ExtensionOrigin,
) -> Result<FrozenCapture, IntakeError> {
    let mut size = [0; 4];
    input
        .read_exact(&mut size)
        .map_err(|_| IntakeError::Frame)?;
    let size = u32::from_ne_bytes(size) as usize;
    if !(1..=MAX_MESSAGE_BYTES).contains(&size) {
        return Err(IntakeError::Frame);
    }
    let mut body = vec![0; size];
    input
        .read_exact(&mut body)
        .map_err(|_| IntakeError::Frame)?;
    let msg: Message = serde_json::from_slice(&body).map_err(|_| IntakeError::Schema)?;
    if msg.version != 1 {
        return Err(IntakeError::Schema);
    }
    let mut context = CaptureContext {
        source: Some(SourceApplication {
            app_id: "aerift_chromium_extension".into(),
        }),
        ..CaptureContext::default()
    };
    match msg.kind {
        Kind::Selection => {
            if msg.value.trim().is_empty()
                || msg.value.len() > MAX_SELECTION_BYTES
                || msg
                    .value
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            {
                return Err(IntakeError::Unsupported);
            }
            context.explicit_selection.push(Candidate::inline(
                RiftObjectKind::PlainText,
                "Selected text",
                msg.value.into_bytes(),
                "text/plain",
            ));
        }
        kind => {
            if !is_reference(&msg.value) {
                return Err(IntakeError::Unsupported);
            }
            let (object_kind, title) = match kind {
                Kind::Target => (RiftObjectKind::Url, "Browser target"),
                Kind::Media => (RiftObjectKind::MediaReference, "Browser media reference"),
                Kind::Page => (RiftObjectKind::WebPage, "Browser page reference"),
                Kind::Selection => unreachable!(),
            };
            let candidate =
                Candidate::inline(object_kind, title, msg.value.into_bytes(), "text/uri-list");
            match kind {
                Kind::Target => context.explicit_targets.push(candidate),
                Kind::Media => context.active_content = Some(candidate),
                Kind::Page => context.active_page = Some(candidate),
                Kind::Selection => unreachable!(),
            }
        }
    }

    freeze(
        context,
        CaptureLimits {
            entries: 1,
            depth: 1,
            inline_bytes: MAX_SELECTION_BYTES,
            total_bytes: MAX_SELECTION_BYTES as u64,
        },
    )
    .map_err(|_| IntakeError::Capture)
}

/// Conservative acceptance of an inert URI reference, not a browser parser or
/// authorization to navigate. Accept browser-normalized lower-case HTTP(S) only.
fn is_reference(value: &str) -> bool {
    if value.len() > MAX_URL_BYTES
        || value
            .bytes()
            .any(|b| !b.is_ascii_graphic() || matches!(b, b'?' | b'#' | b'\\' | b'"' | b'<' | b'>'))
    {
        return false;
    }
    let Some((authority, _)) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    let (host, port) = if authority.starts_with('[') {
        let Some(index) = authority.find(']') else {
            return false;
        };
        if authority[1..index].parse::<std::net::Ipv6Addr>().is_err() {
            return false;
        }
        (&authority[..=index], &authority[index + 1..])
    } else {
        let (host, port) = authority
            .split_once(':')
            .map_or((authority, ""), |(host, _)| {
                (host, &authority[host.len()..])
            });
        if !host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
        {
            return false;
        }
        (host, port)
    };
    !host.is_empty()
        && (port.is_empty()
            || port.strip_prefix(':').is_some_and(|port| {
                !port.is_empty()
                    && port.bytes().all(|b| b.is_ascii_digit())
                    && port.parse::<u16>().is_ok()
            }))
}

use std::time::{Duration, Instant};
use uuid::Uuid;

/// One native-owned, expiring in-memory slot. Browser origin is not local
/// pickup permission; the app must independently arm and review this object.
#[derive(Default)]
pub struct BrowserPickup(Option<PickupSlot>);

enum PickupSlot {
    Armed(Uuid, Instant),
    Review(Uuid, Instant, FrozenCapture),
}

pub struct BrowserReview {
    pub id: Uuid,
    pub kind: RiftObjectKind,
    /// Show in the local app as inert exact text, never HTML or a live link.
    pub literal: String,
}

impl BrowserPickup {
    /// A deliberately initiated app action creates a fresh one-use capability.
    pub fn arm(&mut self, now: Instant) -> Uuid {
        let ticket = Uuid::new_v4();
        self.0 = Some(PickupSlot::Armed(ticket, now + Duration::from_secs(45)));
        ticket
    }

    pub fn cancel(&mut self) {
        self.0 = None;
    }

    pub fn expire(&mut self, now: Instant) {
        if self.0.as_ref().is_some_and(|slot| match slot {
            PickupSlot::Armed(_, deadline) | PickupSlot::Review(_, deadline, _) => now >= *deadline,
        }) {
            self.cancel();
        }
    }

    /// Submit a complete bounded frame read outside any application state
    /// lock. Correct tickets are consumed even when their payload is malformed.
    pub fn submit(
        &mut self,
        ticket: Uuid,
        now: Instant,
        frame: &[u8],
        origin: &ExtensionOrigin,
    ) -> Result<BrowserReview, IntakeError> {
        self.expire(now);
        if !matches!(&self.0, Some(PickupSlot::Armed(expected, _)) if ticket == *expected) {
            return Err(IntakeError::Origin);
        }
        self.cancel();
        if frame.len() > MAX_MESSAGE_BYTES + size_of::<u32>() {
            return Err(IntakeError::Frame);
        }
        let mut bytes = frame;
        let capture = receive_one(&mut bytes, origin)?;
        if !bytes.is_empty() {
            return Err(IntakeError::Frame);
        }
        let [entry] = capture.entries() else {
            return Err(IntakeError::Capture);
        };
        let mut literal = String::new();
        entry
            .open_verified()
            .map_err(|_| IntakeError::Capture)?
            .take((MAX_SELECTION_BYTES + 1) as u64)
            .read_to_string(&mut literal)
            .map_err(|_| IntakeError::Capture)?;
        if literal.len() > MAX_SELECTION_BYTES {
            return Err(IntakeError::Capture);
        }
        let id = Uuid::new_v4();
        let kind = capture.kind;
        self.0 = Some(PickupSlot::Review(
            id,
            now + Duration::from_secs(30),
            capture,
        ));
        Ok(BrowserReview { id, kind, literal })
    }

    /// Deliberate local action only. App receives ownership, not send authority.
    pub fn confirm(&mut self, id: Uuid, now: Instant) -> Result<FrozenCapture, IntakeError> {
        self.expire(now);
        if !matches!(&self.0, Some(PickupSlot::Review(expected, _, _)) if id == *expected) {
            return Err(IntakeError::Origin);
        }
        match self.0.take() {
            Some(PickupSlot::Review(_, _, capture)) => Ok(capture),
            _ => Err(IntakeError::Origin),
        }
    }
}
