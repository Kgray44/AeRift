//! Native, explicit-session-only occupancy surface. This window is not a
//! permission source and cannot start capture.
use std::{
    marker::PhantomData, ptr::{null, null_mut}, rc::Rc,
    sync::{atomic::{AtomicBool, Ordering}, Arc},
};
use aerift_transfer::ambient_camera::CameraIssue;
use windows_sys::Win32::{
    Foundation::{HWND, RECT},
    UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, IsWindowVisible, SetWindowPos,
        SystemParametersInfoW, HWND_TOPMOST, SPI_GETWORKAREA, SWP_NOACTIVATE,
        SWP_SHOWWINDOW, WS_BORDER, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
    },
};

const WIDTH: i32 = 232;
const HEIGHT: i32 = 30;
const MARGIN: i32 = 12;
const STATIC_CLASS: [u16; 7] = [83, 84, 65, 84, 73, 67, 0];

#[derive(Default)]
pub(super) struct Occupancy {
    visible: AtomicBool,
    live: AtomicBool,
    revoked: AtomicBool,
}

impl Occupancy {
    pub(super) fn visible(&self) -> bool {
        self.visible.load(Ordering::Acquire) && !self.revoked.load(Ordering::Acquire)
    }

    pub(super) fn occupying(&self) -> bool {
        self.visible() && self.live.load(Ordering::Acquire)
    }

    fn revoke(&self) {
        self.revoked.store(true, Ordering::Release);
    }
}

pub(super) struct Surface {
    window: HWND,
    state: Arc<Occupancy>,
    _thread_affine: PhantomData<Rc<()>>,
}

impl Surface {
    pub(super) fn display() -> Result<Self, CameraIssue> {
        let state = Arc::new(Occupancy::default());
        let text: Vec<u16> = " AeRift camera session enabled".encode_utf16().chain([0]).collect();
        // Present this independent, non-focusable notice in the primary
        // work area; no persisted configuration or WebView is involved.
        let mut work: RECT = unsafe { std::mem::zeroed() };
        if unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, (&mut work as *mut RECT).cast(), 0) } == 0
            || work.right.saturating_sub(work.left) < WIDTH + MARGIN * 2
            || work.bottom.saturating_sub(work.top) < HEIGHT + MARGIN * 2
        {
            return Err(CameraIssue::IndicatorUnavailable);
        }
        let x = work.right - WIDTH - MARGIN;
        let y = work.top + MARGIN;
        // SAFETY: valid zero-terminated strings, owner thread and hidden
        // window on creation; SetWindowPos makes it visible without focus.
        let window = unsafe { CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, STATIC_CLASS.as_ptr(), text.as_ptr(),
            WS_POPUP | WS_BORDER, x, y, WIDTH, HEIGHT, null_mut(), null_mut(), null_mut(), null(),
        ) };
        if window.is_null() {
            return Err(CameraIssue::IndicatorUnavailable);
        }
        let surface = Self { window, state, _thread_affine: PhantomData };
        if unsafe { SetWindowPos(window, HWND_TOPMOST, x, y, WIDTH, HEIGHT,
            SWP_SHOWWINDOW | SWP_NOACTIVATE) } == 0
            || unsafe { IsWindowVisible(window) } == 0
        {
            return Err(CameraIssue::IndicatorUnavailable);
        }
        surface.state.visible.store(true, Ordering::Release);
        Ok(surface)
    }

    /// A native window-manager visibility assertion, not a pixel/occlusion proof.
    pub(super) fn check(&self) -> bool {
        if unsafe { IsWindowVisible(self.window) } == 0 {
            self.state.revoke();
        }
        self.state.visible()
    }

    pub(super) fn occupancy(&self) -> Arc<Occupancy> {
        self.state.clone()
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        self.state.revoke();
        self.state.visible.store(false, Ordering::Release);
        // The session owner drops/joins its camera supervisor first.
        unsafe { DestroyWindow(self.window); }
    }
}

pub(super) struct ProviderIndicator(pub(super) Arc<Occupancy>);
pub(super) struct Guard(Arc<Occupancy>);

impl crate::ambient_media_foundation::NativeIndicator for ProviderIndicator {
    type Guard = Guard;

    fn occupancy_probe(&self) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let occupancy = self.0.clone();
        Arc::new(move || occupancy.occupying())
    }

    fn show(&mut self) -> Result<Self::Guard, CameraIssue> {
        if !self.0.visible()
            || self.0.live.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err()
        {
            return Err(CameraIssue::IndicatorUnavailable);
        }
        let guard = Guard(self.0.clone());
        guard.0.visible().then_some(guard).ok_or(CameraIssue::IndicatorUnavailable)
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.0.revoke();
        self.0.live.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ambient_media_foundation::NativeIndicator;

    #[test]
    fn pending_or_revoked_surface_never_grants_a_sensor_lease() {
        let state = Arc::new(Occupancy::default());
        let mut indicator = ProviderIndicator(state.clone());
        assert!(indicator.show().is_err());
        state.visible.store(true, Ordering::Release);
        let lease = indicator.show().unwrap();
        assert!(state.occupying());
        assert!(indicator.show().is_err());
        state.revoke();
        assert!(!state.occupying());
        drop(lease);
        assert!(indicator.show().is_err());
    }

    #[test]
    fn releasing_occupancy_ends_this_explicit_session() {
        let state = Arc::new(Occupancy::default());
        state.visible.store(true, Ordering::Release);
        let mut indicator = ProviderIndicator(state.clone());
        drop(indicator.show().unwrap());
        assert!(!state.occupying());
        assert!(indicator.show().is_err());
    }
}
