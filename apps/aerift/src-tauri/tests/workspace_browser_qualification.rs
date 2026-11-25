#![cfg(windows)]

// Default run remains compile/policy only. The native fixture below is ignored
// unless explicitly run inside a disposable offline Windows environment.
#[path = "../src/workspace_browser_policy.rs"]
mod workspace_browser_policy;
#[allow(dead_code)]
#[path = "../src/workspace_browser_sandbox.rs"]
mod workspace_browser_sandbox;

#[allow(dead_code)]
#[path = "../src/workspace_browser_request_owner.rs"]
mod workspace_browser_request_owner;

#[path = "../src/workspace_browser_viewport.rs"]
mod workspace_browser_viewport;

#[test]
fn isolation_source_has_no_app_bridge_registration() {
    let source = include_str!("../src/workspace_browser_sandbox.rs");
    let live: String = source.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>().join("\n");
    for forbidden in [".with_ipc_handler(", ".with_custom_protocol(",
        ".with_initialization_script(", ".evaluate_script("] {
        assert!(!live.contains(forbidden), "{forbidden}");
    }
    assert!(live.contains("SetIsWebMessageEnabled(false)"));
    assert!(live.contains("SetAreHostObjectsAllowed(false)"));
}

#[path = "fixtures/workspace_browser_fixture.rs"]
mod workspace_browser_fixture;

#[test]
#[ignore = "requires an isolated disposable Windows runner with outbound traffic denied"]
fn native_closed_fixture_has_no_bridge_and_denies_unlisted_resource() {
    use std::{
        num::NonZeroIsize,
        ptr::{null, null_mut},
        thread,
        time::{Duration, Instant},
    };
    use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, DispatchMessageW, MSG,
            PM_REMOVE, PeekMessageW, TranslateMessage, WS_OVERLAPPED},
    };
    use workspace_browser_fixture::Observations;
    use workspace_browser_request_owner::{Admission, Reply, Request, RequestOwner};
    use workspace_browser_sandbox::WorkspaceBrowserSandbox;
    use workspace_browser_viewport::{ClientRect, TrustedViewport, ViewportLayout};
    use wry::{Rect, dpi::{PhysicalPosition, PhysicalSize}};

    assert_eq!(std::env::var("AERIFT_ISOLATED_WEBVIEW_FIXTURE").as_deref(), Ok("1"),
        "run only from the documented disposable offline runner");
    // The opt-in marker is a guard against accidental runs, not egress
    // enforcement. The runner must already have its own deny-all isolation.
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) { unsafe { CoUninitialize() } }
    }
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }.expect("fixture STA");
    let _com = Com;

    struct Parent(HWND);
    impl HasWindowHandle for Parent {
        fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
            let hwnd = NonZeroIsize::new(self.0 as isize).ok_or(HandleError::Unavailable)?;
            Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(hwnd))) })
        }
    }
    impl Drop for Parent {
        fn drop(&mut self) { unsafe { DestroyWindow(self.0); } }
    }
    let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
    let parent = Parent(unsafe {
        CreateWindowExW(0, class.as_ptr(), null(), WS_OVERLAPPED, 0, 0, 640, 480,
            null_mut(), null_mut(), null_mut(), null())
    });
    assert!(!parent.0.is_null(), "create hidden fixture parent");
    let scratch = tempfile::tempdir().expect("isolated scratch directory");
    let observations = Observations::default();
    let bounds = Rect {
        position: PhysicalPosition::new(0, 0).into(),
        size: PhysicalSize::new(620, 460).into(),
    };
    let slot = ClientRect { left: 20, top: 72, right: 620, bottom: 450 };
    let layout = ViewportLayout {
        client: ClientRect { left: 0, top: 0, right: 640, bottom: 480 },
        reserved: slot, chrome_bottom: 72, active: true, minimized: false, obstructed: false,
    };
    let mut owner = RequestOwner::<TrustedViewport>::new(Admission::ClosedFixture, layout);
    let (queued, ticket) = owner.request(Request::Present {
        generation: 0, address: workspace_browser_fixture::START,
    });
    assert_eq!(queued, Reply::Accepted);
    let view = WorkspaceBrowserSandbox::open_fixture(&parent, scratch.path(), bounds, observations.clone())
        .expect("create a guarded fixture view");
    assert_eq!(owner.complete(ticket.expect("admitted fixture"), Ok(TrustedViewport::from_hidden(view))),
        Reply::Presented { width_px: 600, height_px: 378, can_back: false, can_forward: false });
    assert_eq!(owner.request(Request::Navigate { generation: 0, address: workspace_browser_fixture::DENIED }).0, Reply::Denied);
    let deadline = Instant::now() + Duration::from_secs(18);
    while Instant::now() < deadline {
        // Bounded dispatch prevents continuous synthetic messages keeping the
        // loop alive longer than its deadline.
        for _ in 0..64 {
            let mut message = MSG::default();
            if unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) } == 0 { break; }
            unsafe { TranslateMessage(&message); DispatchMessageW(&message); }
        }
        if observations.marker.get() > 0 && observations.denied.get() > 0 { break; }
        thread::sleep(Duration::from_millis(12));
    }
    assert!(observations.document.get() > 0, "the fixture document was served");
    assert!(observations.script.get() > 0, "the fixture script was served");
    assert!(observations.marker.get() > 0, "fixture observed no AeRift IPC or postMessage bridge");
    assert!(observations.denied.get() > 0, "the inert unlisted image request got a denied response");
    assert_eq!(owner.set_layout(ViewportLayout { obstructed: true, ..layout }), Reply::Unavailable);
    assert_eq!(owner.request(Request::Navigate { generation: 0, address: workspace_browser_fixture::START }).0, Reply::Denied);
    assert_eq!(owner.request(Request::Close { generation: 0 }).0, Reply::Closed);
}
