//! Trusted native layout owner. Not registered in the app or reachable from IPC.
use wry::{Rect, dpi::{PhysicalPosition, PhysicalSize}};
use crate::workspace_browser_sandbox::{SandboxError, WorkspaceBrowserSandbox};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClientRect { pub left: i32, pub top: i32, pub right: i32, pub bottom: i32 }

#[derive(Clone, Copy, Debug)]
pub(crate) struct ViewportLayout {
    /// Parent client rectangle, already in physical pixels.
    pub client: ClientRect,
    /// Reserved native child slot. No CSS viewport or site-controlled coordinates.
    pub reserved: ClientRect,
    /// Bottom edge of trusted app toolbar, in the same parent client coordinates.
    pub chrome_bottom: i32,
    pub active: bool,
    pub minimized: bool,
    /// Includes routes, app popups, or native dialogs that could cover the child.
    pub obstructed: bool,
}

impl ViewportLayout {
    fn safe_rect(self) -> Option<ClientRect> {
        if !self.active || self.minimized || self.obstructed || self.chrome_bottom < self.client.top {
            return None;
        }
        let r = self.reserved;
        let c = self.client;
        // Hide instead of clipping/offsetting a partly visible native child.
        (r.left >= c.left && r.top >= self.chrome_bottom && r.right <= c.right &&
            r.bottom <= c.bottom && r.left >= 0 && r.top >= 0 &&
            (64..=16_384).contains(&r.right.checked_sub(r.left)?) &&
            (64..=16_384).contains(&r.bottom.checked_sub(r.top)?)).then_some(r)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ViewportState { Closed, Hidden, Visible(ClientRect) }

pub(crate) struct TrustedViewport {
    browser: Option<WorkspaceBrowserSandbox>,
    state: ViewportState,
}

impl TrustedViewport {
    /// Receives an already initialized, still-hidden native child.
    pub(crate) fn from_hidden(browser: WorkspaceBrowserSandbox) -> Self {
        Self { browser: Some(browser), state: ViewportState::Hidden }
    }

    pub(crate) fn state(&self) -> ViewportState { self.state }

    pub(crate) fn layout(&mut self, layout: ViewportLayout) -> Result<ViewportState, SandboxError> {
        let Some(browser) = self.browser.as_ref() else { return Ok(ViewportState::Closed); };
        let next = layout.safe_rect().map_or(ViewportState::Hidden, ViewportState::Visible);
        if next == self.state { return Ok(next); }
        let result = match next {
            ViewportState::Visible(r) => browser.present_at(Rect {
                position: PhysicalPosition::new(r.left, r.top).into(),
                size: PhysicalSize::new((r.right-r.left) as u32, (r.bottom-r.top) as u32).into(),
            }),
            _ => browser.hide(),
        };
        if let Err(error) = result {
            self.close();
            return Err(error);
        }
        self.state = next;
        Ok(next)
    }

    /// Call only in response to trusted chrome navigation, never a page callback.
    pub(crate) fn navigate(&self, address: &str) -> Result<(), SandboxError> {
        if !matches!(self.state, ViewportState::Visible(_)) { return Err(SandboxError::NotApproved); }
        self.browser.as_ref().ok_or(SandboxError::NotApproved)?.navigate(address)
    }

    pub(crate) fn close(&mut self) {
        self.state = ViewportState::Closed;
        // Drop controller even if it could not be reliably hidden.
        drop(self.browser.take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn layout() -> ViewportLayout {
        ViewportLayout {
            client: ClientRect { left: 0, top: 0, right: 800, bottom: 600 },
            reserved: ClientRect { left: 180, top: 70, right: 790, bottom: 590 },
            chrome_bottom: 68, active: true, minimized: false, obstructed: false,
        }
    }
    #[test]
    fn only_fully_contained_slots_below_trusted_chrome_are_eligible() {
        let original = layout();
        assert_eq!(original.safe_rect(), Some(original.reserved));
        for reserved in [
            ClientRect { top: 67, ..original.reserved },
            ClientRect { right: 801, ..original.reserved },
            ClientRect { bottom: 601, ..original.reserved },
            ClientRect { left: 789, ..original.reserved },
            ClientRect { left: i32::MIN, right: i32::MAX, ..original.reserved },
        ] {
            assert_eq!(ViewportLayout { reserved, ..original }.safe_rect(), None);
        }
    }
    #[test]
    fn no_layout_if_route_is_inactive_modal_is_up_or_parent_minimized() {
        let original = layout();
        for view in [
            ViewportLayout { active: false, ..original },
            ViewportLayout { obstructed: true, ..original },
            ViewportLayout { minimized: true, ..original },
        ] {
            assert_eq!(view.safe_rect(), None);
        }
    }
}
