# P8: visible private native snapshot refresh

Base: `ad81d450` (the post-#87 main). This isolated slice updates Private Remote file and folder snapshots and the Windows Friends **file-transfer panel**. It deliberately does not edit DesktopApp's Friends contacts/verification capability polling, and does not alter ordinary native events or any #87 folder authority or native implementation. Native pairing, trust, revoke, disposition and expiry remain authoritative.

Previously Private Remote started one snapshot immediately, every 750 ms, and directly after an action. Neither interval nor action refresh shared an in-flight guard. The Friends file panel ran every 1,000 ms in the mounted window even while hidden and dropped refresh triggers if a request was in flight. A visually hidden window could therefore spend IPC with no user-facing benefit. Compare before/after on the actual exported scheduler using replay of those old invocation patterns.

## Measurement

`npm test && node scripts/perf/measure-visible-refresh.mjs` runs real Node timers and mocked IPC promises with instrumented start/concurrency. Three trials, each with six scenarios side by side: 3.2 s visible (35 ms reply), 3.9 s hidden (35 ms reply), then ~3.76 s visible with 1.25 s reply; three simultaneous mutation invalidations at +210 ms of the final phase. Measurements are scheduler/IPC-harness counts, **not** Windows WebView background throttle or native command duration. Platforms may throttle the old hidden timer anyway. Refocus latency is an observed scripted first request, not end-to-end responsiveness.

| Case | Fast visible starts | Hidden starts | Slow visible starts, including invalidations | Peak in flight |
|---|---:|---:|---:|---:|
| Private Remote before | 5 | 5 | 8 | 5 |
| Private Remote after | 5 | 0 | 3 | 1 |
| Friends file panel before | 4 | 4 | 2 | 1 |
| Friends file panel after | 4 | 0 | 3 | 1 |
| Private Remote folder panel before | 4 | 4 | 3 | 2 |
| Private Remote folder panel after | 4 | 0 | 3 | 1 |

The extra Friends visible request serves the immediate refocus plus queued invalidation that the old logic could miss; periodic timing does not accelerate after a slow reply. In a healthy visible window, refresh retains the existing 750/1,000 ms pacing. Slow requests are serialized, with one merged successor after a local mutation. On refocus, an immediate fresh snapshot is scheduled. Across hidden time the UI suppresses stale or out-of-order replies. Remote retains mounted editors while its native offer controls are disabled until a fresh snapshot; Stop Remote remains available. No work is launched merely because of focus except read-only UI state already authorized by that view.

Controlled contract tests verify visible cadence, zero hidden calls, post-mutation ordering, and React-style effect rehearsal disposal. The browser wrapper observes document visibility, not native trust. Genuine Windows minimization behavior and CPU/memory improvement require native profiling. The folder inspection command uses a distinct scope and preserves the verified-envelope vs exported-tree receipt distinction. DesktopApp route/capability coalescing is deferred because the existing off-route readiness probe bootstraps whether the Friends route exists. Pausing or clearing that state with an ordinary view-poll policy could remove the Friends navigation and change lifecycle semantics.
