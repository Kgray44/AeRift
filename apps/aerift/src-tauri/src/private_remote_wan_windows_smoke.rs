//! Windows Rust test target only. No credentials, WAN transport, or download.
use super::*;
use std::{sync::mpsc, time::Duration};

#[derive(serde::Deserialize)]
struct Witness {
    document: bool,
    css: bool,
    csp: bool,
    ipc: bool,
    scoped_action: bool,
    blocked_navigation: bool,
}

#[derive(Default)]
struct Observed(Mutex<Option<Witness>>);

#[tauri::command]
fn private_wan_smoke_report(window: WebviewWindow, witness: Witness) -> Result<(), TransferError> {
    if window.label() != WINDOW || !window.url().is_ok_and(|url| allowed_document(&url)) {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let observed = window.state::<Arc<Observed>>();
    *observed.inner().as_ref().0.lock().unwrap() = Some(witness);
    window.close().map_err(|_| ErrorCode::InternalError.into())
}

const CHECK: &str = r#"
window.addEventListener("DOMContentLoaded", async () => {
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const witness = { document: false, css: false, csp: false, ipc: false,
    scoped_action: false, blocked_navigation: false };
  try {
    witness.document = document.title === "AeRift Remote" && location.pathname === "/remote-wan.html";
    witness.css = getComputedStyle(document.querySelector("main")).maxWidth !== "none";
    const snapshot = await invoke("private_wan_action", {action: {type: "snapshot"}});
    const rendered = await new Promise(resolve => {
      let checks = 0;
      const poll = setInterval(() => {
        if (document.getElementById("my-card")?.value === snapshot.card) {
          clearInterval(poll); resolve(true);
        } else if (++checks === 20) {
          clearInterval(poll); resolve(false);
        }
      }, 100);
    });
    witness.ipc = rendered && snapshot.type === "snapshot" && snapshot.card.startsWith("aerift-card-v1:")
      && snapshot.devices.length === 0 && snapshot.offers.length === 0 && snapshot.pending === null;
    try {
      await invoke("private_wan_action", {action: {type: "cancelInvite"}});
    } catch (error) {
      witness.scoped_action = error?.code === "peer_unavailable";
    }
    const blocked = await new Promise(resolve => {
      const fallback = setTimeout(() => resolve(false), 2500);
      document.addEventListener("securitypolicyviolation", event => {
        if (event.blockedURI.startsWith("data") && event.effectiveDirective.startsWith("script-src")) {
          clearTimeout(fallback); resolve(true);
        }
      }, {once:true});
      const probe = document.createElement("script");
      probe.src = "data:text/javascript,window.__wanCspProbeRan%3Dtrue";
      document.head.append(probe);
    });
    witness.csp = blocked && window.__wanCspProbeRan !== true;
    // Same virtual origin; a failed navigation gate still cannot contact a network.
    location.assign("/wan-smoke-unregistered.html");
    await new Promise(resolve => setTimeout(resolve, 350));
    witness.blocked_navigation = location.pathname === "/remote-wan.html";
  } finally {
    await invoke("private_wan_smoke_report", {witness});
  }
}, {once:true});
"#;

#[test]
#[ignore = "requires a separately authorized disposable Windows WebView2 runner"]
fn windows_wan_preview_smoke_without_transport() {
    // Never launch the WebView merely by running the usual test suite.
    assert_eq!(env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
    assert_eq!(
        env::var("AERIFT_DISPOSABLE_WINDOWS_WAN_SMOKE").as_deref(),
        Ok("1")
    );
    assert!(
        DIRECT_BIND.is_none() && DIRECT_PEER_KEY.is_none() && DIRECT_PEER_ADDR.is_none(),
        "compile the smoke without any direct route input"
    );

    let temp = tempfile::tempdir().unwrap();
    let profile_root = temp.path().join("synthetic-profile");
    fs::create_dir(&profile_root).unwrap();
    let (profile, card) = derive_offline_in_profile(&profile_root).unwrap();
    let controller = Arc::new(PreviewController::OfflineSmoke {
        profile: Mutex::new(Some(profile)),
        card,
    });
    assert!(crate::windows_storage::lock_profile(&profile_root).is_err());

    // Force every Tauri directory and WebView2 user-data file into the same
    // disposable fixture. Never resolve or substitute the actual app profile.
    let mut context = private_context();
    context.config_mut().identifier = "invalid.aerift.wan-smoke".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(temp.path().join("sandbox")),
    );
    let observation = Arc::new(Observed::default());
    let app = tauri::Builder::<Wry>::default()
        .any_thread()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::clone(&controller))
        .manage(Arc::clone(&observation))
        .invoke_handler(tauri::generate_handler![
            private_wan_action,
            private_wan_smoke_report
        ])
        .build(context)
        .unwrap();
    private_window(&app)
        .data_directory(temp.path().join("webview-data"))
        .additional_browser_args(concat!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
            "--disable-background-networking --disable-component-update --no-first-run ",
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE tauri.localhost"
        ))
        .initialization_script(CHECK)
        .build()
        .unwrap();

    let gate = Arc::new(ExitGate::default());
    let active = Arc::new(Mutex::new(Some(controller)));
    let watchdog_handle = app.handle().clone();
    let watchdog_gate = Arc::clone(&gate);
    let watchdog_active = Arc::clone(&active);
    let (done, wait) = mpsc::channel();
    let watchdog = std::thread::spawn(move || {
        if wait.recv_timeout(Duration::from_secs(12)).is_err()
            && watchdog_gate.requested() == ExitAction::StartShutdown
        {
            shutdown_after_join(watchdog_handle, watchdog_gate, &watchdog_active, 2);
        }
    });
    let code = run_qualification_app(app, active, Arc::clone(&gate));
    let _ = done.send(());
    watchdog.join().unwrap();

    assert_eq!(code, 0, "WebView smoke must reach the normal exit gate");
    assert_eq!(gate.requested(), ExitAction::Allow);
    let witness = observation
        .0
        .lock()
        .unwrap()
        .take()
        .expect("native report absent");
    assert!(witness.document, "wrong embedded document");
    assert!(witness.css, "local CSS did not load");
    assert!(witness.csp, "data: script was not blocked by CSP");
    assert!(witness.ipc, "native snapshot did not render");
    assert!(witness.scoped_action, "offline fixture accepted a mutation");
    assert!(witness.blocked_navigation, "unexpected navigation");
    assert!(crate::windows_storage::lock_profile(&profile_root).is_ok());
    assert!(!profile_root.join(RECEIVE_DIRECTORY).exists());
    assert!(!profile_root.join("remote-wan-trust-v1.dpapi").exists());
}
