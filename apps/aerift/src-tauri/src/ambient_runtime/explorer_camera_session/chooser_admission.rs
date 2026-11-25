//! Native chooser continuation only. Neither an AppPort nor persisted permission.
use std::{
    ffi::OsString,
    os::windows::ffi::OsStrExt,
    time::{Duration, Instant},
};

use aerift_transfer::ambient_camera::{CameraIssue, RgbLandmarker};

use super::{AmbientRuntime, CaptureAnchor, ExplorerCameraEnd, ExplorerCameraSession};
use crate::{ambient_context, ambient_media_foundation::NativeCameraGrant};

const MAX_DEVICES: usize = 16;
const MAX_LABEL: usize = 100;
const MAX_AGE: Duration = Duration::from_secs(30);

/// Native metadata enumeration, not a path received from HTML or config.
pub(crate) struct NativeCameraChoice {
    pub(crate) label: String,
    pub(crate) device_link: OsString,
}

pub(crate) struct CameraChooser<A> {
    anchor: A,
    began: Instant,
    inventory: Vec<NativeCameraChoice>,
}

impl<A: Copy + Eq> CameraChooser<A> {
    pub(super) fn new(
        anchor: A,
        began: Instant,
        inventory: Vec<NativeCameraChoice>,
    ) -> Result<Self, CameraIssue> {
        if inventory.is_empty() || inventory.len() > MAX_DEVICES {
            return Err(CameraIssue::DeviceUnavailable);
        }
        for (index, device) in inventory.iter().enumerate() {
            let link: Vec<_> = device.device_link.encode_wide().take(4097).collect();
            if device.label.trim().is_empty()
                || device.label.chars().count() > MAX_LABEL
                || device.label.chars().any(|ch| {
                    ch.is_control()
                        || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                })
                || link.len() < 5
                || link.len() > 4096
                || link.contains(&0)
                || link[..4] != [92, 92, 63, 92]
                || inventory[..index]
                    .iter()
                    .any(|seen| seen.device_link == device.device_link)
            {
                return Err(CameraIssue::DeviceUnavailable);
            }
        }
        Ok(Self {
            anchor,
            began,
            inventory,
        })
    }

    /// Render in the native chooser only. No symbolic device ID reaches a WebView.
    pub(crate) fn labels(&self) -> impl Iterator<Item = (usize, &str)> {
        self.inventory
            .iter()
            .enumerate()
            .map(|(index, device)| (index, device.label.as_str()))
    }

    fn consume(
        self,
        confirmed_index: Option<usize>,
        current: Option<A>,
        now: Instant,
        os_permission_now: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Result<NativeCameraGrant, CameraIssue> {
        let index = confirmed_index.ok_or(CameraIssue::PermissionDenied)?;
        if current != Some(self.anchor)
            || !now
                .checked_duration_since(self.began)
                .is_some_and(|age| age < MAX_AGE)
        {
            return Err(CameraIssue::PermissionDenied);
        }
        let device = self
            .inventory
            .get(index)
            .ok_or(CameraIssue::DeviceUnavailable)?;
        // Grant checks once now and keeps consulting this native permission
        // source in preflight, acquisition, owner and landmark publishing.
        NativeCameraGrant::from_native_choice(&device.device_link, true, os_permission_now)
    }
}

impl AmbientRuntime {
    /// Call from a deliberate native command with Explorer foreground before
    /// opening the chooser. No permission query or device source is opened here.
    pub(crate) fn prepare_explorer_camera_choice(
        &self,
        inventory: Vec<NativeCameraChoice>,
    ) -> Result<CameraChooser<(CaptureAnchor, u64)>, ExplorerCameraEnd> {
        let anchor =
            ambient_context::capture_anchor().map_err(|_| ExplorerCameraEnd::ContextLost)?;
        let (generation, _) = self.explorer_session_policy(anchor)?;
        CameraChooser::new((anchor, generation), Instant::now(), inventory)
            .map_err(ExplorerCameraEnd::Unavailable)
    }

    /// Consume once following explicit confirmation and restoration of the
    /// original eligible Explorer foreground. Never restart this choice.
    pub(crate) fn confirm_explorer_camera_choice(
        &self,
        choice: CameraChooser<(CaptureAnchor, u64)>,
        confirmed_index: Option<usize>,
        os_permission_now: impl Fn() -> bool + Send + Sync + 'static,
        model: impl RgbLandmarker,
    ) -> Result<ExplorerCameraSession, ExplorerCameraEnd> {
        let (expected, expected_epoch) = choice.anchor;
        let (epoch, _) = self.explorer_session_policy(expected)?;
        let current = ambient_context::capture_anchor()
            .ok()
            .map(|anchor| (anchor, epoch));
        let grant = choice
            .consume(confirmed_index, current, Instant::now(), os_permission_now)
            .map_err(ExplorerCameraEnd::Unavailable)?;
        self.start_explorer_camera_session(expected, expected_epoch, grant, model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn device(label: &str) -> NativeCameraChoice {
        NativeCameraChoice {
            label: label.into(),
            device_link: r"\\?\fixture-camera".into(),
        }
    }

    #[test]
    fn native_choice_is_bounded_and_has_no_implicit_confirm() {
        let now = Instant::now();
        assert!(CameraChooser::new(1, now, vec![device("Camera"), device("Duplicate")]).is_err());
        assert!(CameraChooser::new(1, now, vec![device("Cam\nFake")]).is_err());
        let chooser = CameraChooser::new(1, now, vec![device("Camera")]).unwrap();
        assert_eq!(chooser.labels().collect::<Vec<_>>(), [(0, "Camera")]);
        assert!(matches!(
            chooser.consume(None, Some(1), now, || panic!("must not check permission")),
            Err(CameraIssue::PermissionDenied)
        ));
    }

    #[test]
    fn rejects_wrong_origin_expiry_and_missing_os_permission() {
        let now = Instant::now();
        for (current, time) in [(Some(2), now), (Some(1), now + MAX_AGE)] {
            let chooser = CameraChooser::new(1, now, vec![device("Camera")]).unwrap();
            assert!(matches!(
                chooser.consume(Some(0), current, time, || panic!(
                    "must not check permission"
                )),
                Err(CameraIssue::PermissionDenied)
            ));
        }
        let chooser = CameraChooser::new(1, now, vec![device("Camera")]).unwrap();
        assert!(matches!(
            chooser.consume(Some(0), Some(1), now, || false),
            Err(CameraIssue::PermissionDenied)
        ));
    }
}
