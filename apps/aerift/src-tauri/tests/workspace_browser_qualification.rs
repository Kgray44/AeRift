#![cfg(windows)]

// Opt-in compilation proves Rust/COM compatibility only. Nothing in this
// target creates a window, opens a page or attaches to the production host.
#[path = "../src/workspace_browser_policy.rs"]
mod workspace_browser_policy;
#[allow(dead_code)]
#[path = "../src/workspace_browser_sandbox.rs"]
mod workspace_browser_sandbox;

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
