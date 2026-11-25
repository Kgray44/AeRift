//! Windows proof only. NOT wired to the application, IPC, or release.
//! Mount a raw Wry WebView2 child instead of a Tauri-managed WebView.
use std::{fs, os::windows::fs::MetadataExt, path::Path, rc::Rc};

use raw_window_handle::HasWindowHandle;
use tempfile::{Builder, TempDir};
use webview2_com::{
    LaunchingExternalUriSchemeEventHandler, Microsoft::Web::WebView2::Win32::*,
    NavigationStartingEventHandler, WebResourceRequestedEventHandler, take_pwstr,
};
use windows::core::{BOOL, HSTRING, Interface, PWSTR, w};
use wry::{
    NewWindowResponse, PermissionResponse, Rect, WebContext, WebView, WebViewBuilder,
    WebViewBuilderExtWindows, WebViewExtWindows,
};

#[cfg(test)]
use crate::workspace_browser_fixture::{ClosedFixture, DENIED, ORIGIN, Observations, START};
use crate::workspace_browser_policy::BrowserPolicy;

#[derive(Debug)]
pub(crate) enum SandboxError {
    NotApproved,
    ScratchUnavailable,
    BrowserUnavailable,
    SecurityControlsUnavailable,
}

pub(crate) struct WorkspaceBrowserSandbox {
    // Fields drop in declaration order: close controller before scratch cleanup.
    view: WebView,
    _profile: TempDir,
    policy: BrowserPolicy,
}

impl WorkspaceBrowserSandbox {
    /// Call only on the UI STA from a trusted native lifecycle owner. Do not
    /// construct during a synchronous WebView render/IPC callback.
    /// `scratch_root` must be host-resolved, never forwarded by a renderer.
    pub(crate) fn open(
        parent: &impl HasWindowHandle,
        scratch_root: &Path,
        policy: BrowserPolicy,
        initial_url: &str,
        bounds: Rect,
    ) -> Result<Self, SandboxError> {
        Self::open_inner(
            parent,
            scratch_root,
            policy,
            initial_url,
            bounds,
            #[cfg(test)]
            None,
        )
    }

    #[cfg(test)]
    pub(crate) fn open_fixture(
        parent: &impl HasWindowHandle,
        scratch_root: &Path,
        bounds: Rect,
        observations: Observations,
    ) -> Result<Self, SandboxError> {
        let policy =
            BrowserPolicy::from_approved_origins(&[ORIGIN]).ok_or(SandboxError::NotApproved)?;
        Self::open_inner(
            parent,
            scratch_root,
            policy,
            START,
            bounds,
            Some(observations),
        )
    }

    fn open_inner(
        parent: &impl HasWindowHandle,
        scratch_root: &Path,
        policy: BrowserPolicy,
        initial_url: &str,
        bounds: Rect,
        #[cfg(test)] observations: Option<Observations>,
    ) -> Result<Self, SandboxError> {
        let destination = policy
            .approved_url(initial_url)
            .ok_or(SandboxError::NotApproved)?;
        const REPARSE_POINT: u32 = 0x400;
        let metadata =
            fs::symlink_metadata(scratch_root).map_err(|_| SandboxError::ScratchUnavailable)?;
        if !scratch_root.is_absolute()
            || !metadata.is_dir()
            || metadata.file_attributes() & REPARSE_POINT != 0
        {
            return Err(SandboxError::ScratchUnavailable);
        }
        let profile = Builder::new()
            .prefix("aerift-workspace-browser-")
            .tempdir_in(scratch_root)
            .map_err(|_| SandboxError::ScratchUnavailable)?;
        let mut context = WebContext::new(Some(profile.path().to_path_buf()));
        let navigation = policy.clone();
        let view = WebViewBuilder::new_with_web_context(&mut context)
            // No .with_url() until all native restrictions are confirmed.
            // No .with_ipc_handler(), .with_custom_protocol(), or initialization scripts.
            .with_visible(false)
            .with_focused(false)
            .with_bounds(bounds)
            .with_incognito(true)
            .with_devtools(false)
            .with_clipboard(false)
            .with_autoplay(false)
            .with_default_context_menus(false)
            .with_browser_accelerator_keys(false)
            .with_browser_extensions_enabled(false)
            .with_general_autofill_enabled(false)
            .with_navigation_handler(move |url| navigation.approved_url(&url).is_some())
            .with_permission_handler(|_| PermissionResponse::Deny)
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_download_started_handler(|_, _| false)
            .build_as_child(parent)
            .map_err(|_| SandboxError::BrowserUnavailable)?;
        #[cfg(test)]
        let fixture = observations.map(|value| ClosedFixture::new(&view, value));
        install_native_guards(
            &view,
            profile.path(),
            policy.clone(),
            #[cfg(test)]
            fixture,
        )?;
        view.load_url(destination.as_str())
            .map_err(|_| SandboxError::BrowserUnavailable)?;
        Ok(Self {
            view,
            _profile: profile,
            policy,
        })
    }

    pub(crate) fn navigate(&self, raw: &str) -> Result<(), SandboxError> {
        let url = self
            .policy
            .approved_url(raw)
            .ok_or(SandboxError::NotApproved)?;
        self.view
            .load_url(url.as_str())
            .map_err(|_| SandboxError::BrowserUnavailable)
    }

    /// Read only the native history affordances; never export URLs or titles.
    pub(crate) fn history(&self) -> crate::workspace_browser_request_owner::History {
        use crate::workspace_browser_request_owner::History;
        let Some(browser) = self.approved_current_page() else {
            return History::default();
        };
        let mut back = BOOL::default();
        let mut forward = BOOL::default();
        if unsafe {
            browser
                .CanGoBack(&mut back)
                .and_then(|()| browser.CanGoForward(&mut forward))
        }
        .is_err()
        {
            return History::default();
        }
        History {
            can_back: back.as_bool(),
            can_forward: forward.as_bool(),
        }
    }

    /// No alternative navigation primitive, script execution or policy update.
    pub(crate) fn history_action(
        &self,
        action: crate::workspace_browser_request_owner::HistoryAction,
    ) -> Result<(), SandboxError> {
        use crate::workspace_browser_request_owner::HistoryAction;
        let browser = self
            .approved_current_page()
            .ok_or(SandboxError::NotApproved)?;
        let available = self.history();
        // The installed NavigationStarting and resource policies still apply to
        // browser-produced navigation and all requests.
        let result = unsafe {
            match action {
                HistoryAction::Back if available.can_back => browser.GoBack(),
                HistoryAction::Forward if available.can_forward => browser.GoForward(),
                HistoryAction::Reload => browser.Reload(),
                _ => return Err(SandboxError::NotApproved),
            }
        };
        result.map_err(|_| SandboxError::BrowserUnavailable)
    }

    fn approved_current_page(&self) -> Option<ICoreWebView2> {
        let browser = self.view.webview();
        let mut source = PWSTR::null();
        unsafe {
            browser.Source(&mut source).ok()?;
        }
        self.policy.approved_url(&take_pwstr(source))?;
        Some(browser)
    }

    pub(crate) fn set_bounds(&self, trusted_bounds: Rect) -> Result<(), SandboxError> {
        self.view
            .set_bounds(trusted_bounds)
            .map_err(|_| SandboxError::BrowserUnavailable)
    }

    /// Present only after trusted native layout admission; never focus the child.
    pub(crate) fn present_at(&self, trusted_bounds: Rect) -> Result<(), SandboxError> {
        self.hide()?;
        self.set_bounds(trusted_bounds)?;
        self.view
            .set_visible(true)
            .map_err(|_| SandboxError::BrowserUnavailable)
    }

    pub(crate) fn hide(&self) -> Result<(), SandboxError> {
        self.view
            .set_visible(false)
            .map_err(|_| SandboxError::BrowserUnavailable)
    }
}

fn install_native_guards(
    view: &WebView,
    scratch: &Path,
    policy: BrowserPolicy,
    #[cfg(test)] fixture: Option<ClosedFixture>,
) -> Result<(), SandboxError> {
    let failure = |_| SandboxError::SecurityControlsUnavailable;
    let browser = view.webview();
    let profile = unsafe {
        browser
            .cast::<ICoreWebView2_13>()
            .and_then(|browser| browser.Profile())
    }
    .map_err(failure)?;
    let mut private = BOOL::default();
    let mut profile_path = PWSTR::null();
    unsafe {
        profile
            .IsInPrivateModeEnabled(&mut private)
            .map_err(failure)?;
        profile.ProfilePath(&mut profile_path).map_err(failure)?;
    }
    let actual = std::path::PathBuf::from(take_pwstr(profile_path));
    let expected = scratch
        .canonicalize()
        .map_err(|_| SandboxError::ScratchUnavailable)?;
    let actual = actual
        .canonicalize()
        .map_err(|_| SandboxError::ScratchUnavailable)?;
    if !private.as_bool() || !actual.starts_with(expected) {
        return Err(SandboxError::SecurityControlsUnavailable);
    }

    // All failures during setup keep the blank child hidden; no remote page runs.
    let result = unsafe {
        let install = || -> windows::core::Result<()> {
            let settings = browser.Settings()?;
            settings.SetAreHostObjectsAllowed(false)?;
            settings.SetIsWebMessageEnabled(false)?;
            settings.SetAreDefaultScriptDialogsEnabled(false)?;
            settings
                .cast::<ICoreWebView2Settings4>()?
                .SetIsPasswordAutosaveEnabled(false)?;
            // Wry 0.57.3 enables non-client regions by default; foreign CSS
            // must not make the AeRift host into a draggable region.
            settings
                .cast::<ICoreWebView2Settings9>()?
                .SetIsNonClientRegionSupportEnabled(false)?;
            view.controller()
                .cast::<ICoreWebView2Controller4>()?
                .SetAllowExternalDrop(false)?;

            let policy = Rc::new(policy);
            let frame_policy = Rc::clone(&policy);
            let mut token = 0i64; // Registrations live as long as the private controller.
            browser.add_FrameNavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        // Fail closed on unreadable URI values.
                        args.SetCancel(true)?;
                        let mut uri = PWSTR::null();
                        if args.Uri(&mut uri).is_ok()
                            && frame_policy.approved_url(&take_pwstr(uri)).is_some()
                        {
                            args.SetCancel(false)?;
                        }
                    }
                    Ok(())
                })),
                &mut token,
            )?;

            browser
                .cast::<ICoreWebView2_18>()?
                .add_LaunchingExternalUriScheme(
                    &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args {
                            args.SetCancel(true)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;

            let blocked = view.environment().CreateWebResourceResponse(
                None,
                403,
                &HSTRING::from("Forbidden"),
                &HSTRING::from("Cache-Control: no-store\r\n"),
            )?;
            browser
                .cast::<ICoreWebView2_22>()?
                .AddWebResourceRequestedFilterWithRequestSourceKinds(
                    w!("*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                )?;
            browser.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut uri = PWSTR::null();
                        let raw = args
                            .Request()
                            .and_then(|request| request.Uri(&mut uri))
                            .ok()
                            .map(|()| take_pwstr(uri));
                        let allowed = raw
                            .as_deref()
                            .and_then(|uri| policy.approved_url(uri))
                            .is_some();
                        if !allowed {
                            args.SetResponse(&blocked)?;
                            #[cfg(test)]
                            if let Some(fixture) = &fixture {
                                if raw.as_deref() == Some(DENIED) {
                                    fixture
                                        .observations
                                        .denied
                                        .set(fixture.observations.denied.get() + 1);
                                }
                            }
                        } else {
                            #[cfg(test)]
                            if let (Some(fixture), Some(raw)) = (&fixture, raw.as_deref()) {
                                // Set the closed response first: a failed synthetic stream
                                // must never turn interception into an outbound request.
                                args.SetResponse(&blocked)?;
                                let response = fixture.response(raw)?;
                                args.SetResponse(&response)?;
                            }
                        }
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            Ok(())
        };
        install()
    };
    result.map_err(failure)
}
