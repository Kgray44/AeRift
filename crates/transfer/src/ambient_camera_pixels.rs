use super::{CameraIssue, Landmark};
use std::time::{Duration, Instant};

/// Maximum accepted camera allocation, before accessing bytes or converting rows.
pub const MAX_RGB32_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
pub struct Rgb32Layout {
    width: u16,
    height: u16,
    pitch: usize,
    bottom_up: bool,
    length: usize,
}

impl Rgb32Layout {
    pub fn new(width: u16, height: u16, stride: i32) -> Result<Self, CameraIssue> {
        let (w, h) = (usize::from(width), usize::from(height));
        if !(1..=1920).contains(&w) || !(1..=1920).contains(&h) {
            return Err(CameraIssue::InvalidFrame);
        }
        let pitch =
            usize::try_from(stride.unsigned_abs()).map_err(|_| CameraIssue::InvalidFrame)?;
        if pitch < w * 4 || pitch % 4 != 0 {
            return Err(CameraIssue::InvalidFrame);
        }
        let length = pitch
            .checked_mul(h)
            .filter(|length| *length <= MAX_RGB32_BYTES)
            .ok_or(CameraIssue::InvalidFrame)?;
        Ok(Self {
            width,
            height,
            pitch,
            bottom_up: stride < 0,
            length,
        })
    }

    pub fn bytes(self) -> usize {
        self.length
    }
}

/// One local CPU frame. Deliberately not debug/serde/clone and never sent to a UI or network.
pub struct RgbFrame {
    pub captured: Instant,
    pub width: u16,
    pub height: u16,
    rgb: Vec<u8>,
}

impl RgbFrame {
    pub fn rgb(&self) -> &[u8] {
        &self.rgb
    }

    pub fn from_mf_rgb32(
        captured: Instant,
        width: u16,
        height: u16,
        stride: i32,
        pixels: &[u8],
    ) -> Result<Self, CameraIssue> {
        Self::decode(captured, Rgb32Layout::new(width, height, stride)?, pixels)
    }

    /// Media Foundation packed RGB32 is B,G,R,pad in memory. A negative stride
    /// denotes bottom-up orientation; the contiguous buffer begins at its lowest
    /// address, not the logical top row.
    pub fn decode(
        captured: Instant,
        layout: Rgb32Layout,
        pixels: &[u8],
    ) -> Result<Self, CameraIssue> {
        if pixels.len() != layout.length {
            return Err(CameraIssue::InvalidFrame);
        }
        let w = usize::from(layout.width);
        let h = usize::from(layout.height);
        let mut rgb = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            let row = if layout.bottom_up { h - 1 - y } else { y };
            let start = row * layout.pitch;
            for pixel in pixels[start..start + w * 4].chunks_exact(4) {
                rgb.extend([pixel[2], pixel[1], pixel[0]]);
            }
        }
        Ok(Self {
            captured,
            width: layout.width,
            height: layout.height,
            rgb,
        })
    }
}

/// A pinned local-only native inference adapter. The consumer owns the model and
/// hands these frames to it in the same process. No camera frames leave this API.
pub trait RgbLandmarker: Send + 'static {
    fn preflight(&mut self) -> Result<(), CameraIssue>;
    fn recognize(
        &mut self,
        frame: &RgbFrame,
        budget: Duration,
    ) -> Result<Option<[Landmark; 21]>, CameraIssue>;
}

/// One outstanding asynchronous OS capture read. Late callbacks discard their
/// frames without becoming fresh when observed by the supervisor.
#[derive(Default)]
pub struct DriverReadGate(Option<Instant>);
impl DriverReadGate {
    pub fn begin(&mut self, now: Instant) -> bool {
        if self.0.is_some() {
            return false;
        }
        self.0 = Some(now);
        true
    }

    pub fn stalled(&self, now: Instant) -> bool {
        self.0
            .and_then(|start| now.checked_duration_since(start))
            .is_some_and(|age| age >= Duration::from_millis(300))
    }

    pub fn complete(&mut self, now: Instant) -> Option<Instant> {
        let start = self.0.take()?;
        now.checked_duration_since(start)
            .filter(|age| *age <= super::CAPTURE_FRESHNESS)
            .map(|_| start)
    }
}
