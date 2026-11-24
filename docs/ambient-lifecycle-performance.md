# P1: Windows Ambient lifecycle wake budget

Baseline inspected: e8cab6efff8e4f100ff582b2ef7d945de3fcd64e. This local slice removes the permanent 250 ms timer from the Windows Ambient watchdog when Ambient capture is disabled. It waits on a coalescing Tokio notification instead. Explicit enable/disable, exclusions, pause and A4 opt-in changes wake it; a notification before the await remains pending. A rejected hotkey cleanup does not leave a background authority or a timer running. It does not change the enabled 250 ms fallback, synchronously enforced command permissions, indicator behavior, A7 confirmation, camera settings, or recipient safety checks.

## Measured timing harness (not Windows application performance)

Ten seconds, isolated current-thread Linux Tokio processes, same 250 ms baseline and exact candidate helper, no WebView/network/camera, one run per mode:

| Mode | Watcher callbacks / 10s | User CPU including process startup | Voluntary context switches |
| --- | ---: | ---: | ---: |
| Disabled baseline | 40 | 19.796 ms | 83 |
| Disabled candidate | 0 | 3.379 ms | 5 |
| Enabled candidate | 39 | 19.602 ms | 83 |

CPU numbers are single-run harness observations, not product or battery estimates. The enabled difference of one tick is edge alignment from interval first-tick vs sleep sequencing; fallback cadence is unchanged. A fixture with the exact helper checks no disabled timer, non-lost transition and periodic enabled fallback. Native Windows PT/ETW or WPR measurement and real session/foreground edge qualification still required.

## Separate lifecycle loops, prioritized

* A4 tray hold watches fixed 80 ms while one explicitly held pickup is in flight. Prefer a trusted focused claim-state notification and its exact ambiguity/expiry deadline. Notification can wake resolution but cannot authorize before the arbitration window closes. Retain generation-cancel priority and real consent on transfer.
* A7 polls from one bounded active Explorer receive plan, native 250 ms and UI 350 ms; no dormant A7 interval. After Windows events are verified, use native request state events for UI and an expiry/commit guard on native, not an unproved throttle.
* System overlay native placement rechecks every 500 ms only during a visible, bounded preview. Use native foreground, display, DPI/work-area changes, then a slower periodic safety check. Do not remove fullscreen/suppression fallback and never add desktop pixel capture.
* The camera bridge's health timeout/inference cadence and truthful indicator are not generic polling. Leave them intact in this slice.
* Friend views and Private Remote have separate UI intervals; do not combine their permissions or data into this watchdog.

## Windows event qualification required before slowing the active fallback

Use a lifecycle-owned Win32 window registration scoped to the current session ([WTSRegisterSessionNotification](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification)) and treat lock, disconnect, logoff and unknown states as fail-closed. Observe only out-of-context foreground events via a registered Windows message loop ([SetWinEventHook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)); do not install an input hook, collect window contents, or treat event metadata by itself as permission. On trust loss/re-registration, revoke the active source/receive plan immediately and preserve existing permission rechecks at acquisition and publish. After a real Windows qualification of native delivery, sweeps at 1–2 s can serve as fail-closed reconciliation; a lost/hung event channel must not widen authority (remain on 250 ms or suspend). Measure same exact installer/build across hidden idle, foreground enabled idle, held transfer, active receive, lock/unlock and quick foreground exclusion switches; record watchdog callbacks, Win32 query counts, p95 revoke latency, process CPU and context switches.
