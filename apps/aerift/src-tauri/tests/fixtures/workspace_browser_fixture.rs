// Only included by the opt-in qualification target, never by the app.
use std::{cell::Cell, rc::Rc};

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::{Win32::UI::Shell::SHCreateMemStream, core::{Error, HSTRING}};
use wry::{WebView, WebViewExtWindows};

pub(crate) const ORIGIN: &str = "https://workspace.fixture.invalid";
pub(crate) const START: &str = "https://workspace.fixture.invalid/index.html";
const MARKER: &str = "https://workspace.fixture.invalid/observation/ready";
pub(crate) const DENIED: &str = "https://outside.fixture.invalid/inert.png";

const PAGE: &[u8] = br#"<!doctype html>
<meta charset="utf-8">
<link rel="icon" href="/favicon.ico">
<script defer src="/fixture.js"></script>
<img src="https://outside.fixture.invalid/inert.png" alt="">
<p>AeRift synthetic Workspace browser fixture</p>"#;

const SCRIPT: &[u8] = br#"(() => {
  if (window.__TAURI__ !== undefined || window.__TAURI_INTERNALS__ !== undefined ||
      window.ipc !== undefined || window.chrome?.webview?.postMessage !== undefined) {
    return;
  }
  fetch("/observation/ready", {cache: "no-store"}).catch(() => {});
})();"#;

#[derive(Clone, Default)]
pub(crate) struct Observations {
    pub(crate) document: Rc<Cell<usize>>,
    pub(crate) script: Rc<Cell<usize>>,
    pub(crate) marker: Rc<Cell<usize>>,
    pub(crate) denied: Rc<Cell<usize>>,
}

#[derive(Clone)]
pub(crate) struct ClosedFixture {
    pub(crate) observations: Observations,
    environment: ICoreWebView2Environment,
}

impl ClosedFixture {
    pub(crate) fn new(view: &WebView, observations: Observations) -> Self {
        Self { observations, environment: view.environment() }
    }

    // Every request reaching the fixture gets a synthetic response, even if
    // its allowed origin matches but the exact route is absent. Nothing falls
    // through to the network. The caller still applies BrowserPolicy first.
    pub(crate) fn response(&self, uri: &str) -> windows::core::Result<ICoreWebView2WebResourceResponse> {
        let (body, kind, count): (&[u8], &str, &Cell<usize>) = match uri {
            START => (PAGE, "text/html; charset=utf-8", &self.observations.document),
            "https://workspace.fixture.invalid/fixture.js" =>
                (SCRIPT, "text/javascript; charset=utf-8", &self.observations.script),
            MARKER => (b"ok", "text/plain; charset=utf-8", &self.observations.marker),
            _ => return unsafe {
                self.environment.CreateWebResourceResponse(
                    None, 404, &HSTRING::from("Not Found"), &HSTRING::from("Cache-Control: no-store\r\n"),
                )
            },
        };
        let stream = unsafe { SHCreateMemStream(Some(body)) }
            .ok_or_else(|| Error::from_hresult(windows::core::HRESULT(0x8007000Eu32 as i32)))?;
        let headers = HSTRING::from(format!("Content-Type: {kind}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"));
        let response = unsafe {
            self.environment.CreateWebResourceResponse(&stream, 200, &HSTRING::from("OK"), &headers)
        }?;
        count.set(count.get() + 1);
        Ok(response)
    }
}
