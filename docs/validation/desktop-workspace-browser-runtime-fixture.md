# Closed Windows runtime smoke for the Workspace browser

Baseline: #112 `cc0729ff584f67a15a8513f94dd66d90c974960a`, tree `ccd74ffe61f1830b1422bbf01f7a408c422e5f37`. [Windows compile/policy job 139411260363](https://github.com/Kgray44/AeRift/actions/runs/45672507583/job/139411260363) passed. This fixture patch has not been compiled or executed in the Linux staging environment.

## Scope and guardrails

The existing isolated qualification target is the only consumer. Its test-only fixture module provides immutable synthetic bytes from `https://workspace.fixture.invalid`. Ordinary builds receive no fixture handler, approved fixture origin, synthetic script, or test IPC. The disabled policy is unchanged. No action uses a user's device, system browser, app account, production data, network provider, or app component. The ignored test has no workflow edits or install path.

The same request guard applies the existing allowlist first, and supplies HTTP 403 to every denied request. For approved requests, the closed fixture starts with the denied response before replacing it with an in-memory static response for a known route, or with a synthetic 404. It never falls through to network fetch for those requests. An inert image uses a distinct reserved `.invalid` origin and the native observer records it after the policy returns 403; there is no request to any local or public service. This is not a network firewall. Runner isolation is mandatory because WebView2 may initiate its own traffic outside this interception. Runtime and build must be staged before disabling egress; never loosen TLS checks.

Use only a newly provisioned disposable Windows desktop/VM with WebView2 already installed and outbound networking already denied independently of the browser (and no user profile, tunnel, LAN, credentials, or personal data). A test-local environment marker prevents accidents and does not validate the runner. Compile before disconnecting only if needed for obtaining dependencies; build on the same exact checkout. Keep existing default compile/policy behavior:

```powershell
cargo test --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --features workspace-browser-qualification --test workspace_browser_qualification
```

Once the standalone test binary and dependencies are available, and the host is proven disposable and offline, set the opt-in marker and run only the named ignored test. Enforce a disposable VM/job watchdog in addition to the test's event-pump deadline, since WebView2 construction can block before the test deadline starts. Do not attach this to normal hosted CI without proof of isolation and cleanup. No public host or `hosts` changes are needed.

```powershell
$env:AERIFT_ISOLATED_WEBVIEW_FIXTURE = '1'
cargo test --offline --locked --manifest-path apps/aerift/src-tauri/Cargo.toml --features workspace-browser-qualification --test workspace_browser_qualification native_closed_fixture_has_no_bridge_and_denies_unlisted_resource -- --ignored --exact --test-threads=1
```

## Expected evidence

- Inert fixture creates one hidden native Win32 parent, independent WebView2 profile, and an STA loop. Existing setup rejects missing guards/profile privacy before first request.
- Native counters must observe a synthetic HTML document and same-origin JS, then a same-origin marker emitted only when known AeRift/Tauri bridges and WebView2 postMessage are absent in the fixture page. The test never executes host-injected JavaScript.
- Native counters must observe the unlisted resource receiving policy-denied response; a separate direct host attempt to navigate to that origin must return `NotApproved`. Those assertions do not prove frame navigation, popups, downloads, protocol handlers, permissions, DNS/IP safety, or complete egress isolation. They are not a security release.
- Close/drop view before teardown. Record exact revision, outcome, Windows version, WebView2 version, runner-level egress policy, and elapsed runtime. Note any profile cleanup failures separately; user experience, focus, rendering, native embed integration and public-web browsing remain unverified.

References: [Microsoft WebView2 local content through WebResourceRequested](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content), [WebView2 resource response API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment#CreateWebResourceResponse), [windows-rs 0.62.2 SHCreateMemStream](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/UI/Shell/fn.SHCreateMemStream.html).
