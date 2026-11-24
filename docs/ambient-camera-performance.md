# P3: gesture-camera readiness and frame ownership

Baseline e8cab6efff8e4f100ff582b2ef7d945de3fcd64e. No camera device or permission was touched. Before changing source, the exact pinned MediaPipe 0.10.32 Linux CPU C ABI and model ran against the already-pinned upstream hand photograph and synthetic blank. Five warmups plus 60 calls each: hand 22.88 ms median, 24.99 ms p95, exactly 21 landmarks; blank 12.62 ms median, 14.73 ms p95, zero landmarks. These are image-mode C calls, excluding device, capture, JavaScript/IPC, and rendering latency. Earlier recorded Chromium worker replay evidence documents the live pipeline's software model, not physical Windows camera performance.

## Production change and proxy

The shared iOS/Android JS adapter starts its existing 50 ms native feedback/frame-health watchdog only after the current attempt reports native ready and its monotonic clock has been calibrated. It creates exactly one poller even with repeated ready events. The absolute attempt deadline already runs during startup and remains unchanged; startup/permission teardown and stale attempt handling remain native, and active camera gap/timeout logic, landmark order and classifier inputs are unchanged.

Measured isolated Node with the exact baseline and candidate adapters over one simulated 2.5-second pre-ready startup each (no actual camera), followed by 270 ms ready: baseline 49 pre-ready callbacks and 5 ready callbacks; candidate zero pre-ready and 5 ready callbacks. This small phase-local saving is not an inference speedup, device latency measurement, or battery estimate. All 67 gesture tests pass, including a new red-to-green duplicate/premature watchdog test, existing frame-gap feedback, late start teardown and absolute deadline fixtures.

## Native platform and Windows web boundaries

- Android CameraX: KEEP_ONLY_LATEST plus one delivery per capture attempt; stale/invalid timestamps are rejected before expensive bitmap conversion, rotated bitmap ownership transfers to the native inference wrapper only after its build succeeds, and image data/permission checks remain bounded. Physical tracing is needed before changing rotation or pixel conversion.
- iOS Vision: late frame discard, a 75 ms frame floor, one semaphore-backed delivery, freshness bounds and a native monotonic clock. No evidence justifies changing those bounds.
- Windows normal foreground production path: WebView worker and single transferable bitmap, pacing tied to capture time, closure on stale/error. The separately gated native Media Foundation/MediaPipe qualification path is not a shipping camera default. Neither path changes in this patch.

Qualification needed: actual device frame age/p95, CPU/thermal/power, bridge queue and release timing under WebView2, iOS Vision and CameraX; locally the patch proves ownership and startup callback reduction only.
