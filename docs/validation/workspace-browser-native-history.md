# Qualification-only native history controls

Exact base `5d06c6d9d40c22ff989a3fdfbdea59610d44087e`. The closed-fixture request owner admits Back, Forward and Reload only for the current visible controller. WebView2's current source must match the unchanged statically configured origin policy before any action; back/forward additionally require WebView2's current corresponding affordance. Underlying navigation continues to encounter existing policy hooks; no IPC, resource exception, source text, page address, history contents, or title is exposed. InPrivate scratch-profile behavior is unchanged.

Microsoft [WebView2 ICoreWebView2 documentation](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2) distinguishes action dispatch from confirmed navigation and documents HistoryChanged for settled affordances. Immediate replies report only the current native pane rectangle and a point-in-time affordance snapshot. Product-side HistoryChanged binding and fixture runtime assertions of real native history, focus, and cleanup remain open; no app activation or network allowance.

Five portable Rust owner tests passed with an inert controller. Host Windows compile and the independently offline fixture runtime still need qualification; normal hosted Windows is not a substitute for the latter.
