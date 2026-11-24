# AeRift Ambient native recognition lifecycle

This staged A1 work does not activate a physical camera or change the shipping app's focused camera. It gives a future local native adapter a process-owned worker that does not reference a main window or renderer.

- The worker is off until product preference, OS session state, and an explicit native permission grant all agree. A camera lease opens only after a pinned model is ready and a visible indicator is available, then owns the indicator until after the sensor stops. Unknown OS state stays suspended. Local activation is not equivalent to a trusted peer or a destination.
- Pause, lock, per-app exclusion and shutdown clear retained observations and prevent in-flight results from being published. The worker keeps one replacement-only slot, accepts only fresh valid 21-landmark hand data, and discards pixel buffers at the provider boundary. Camera foreground visibility is not an authorization input.
- Normal cadence requests 640x480 and 20 samples/second. Battery-saver mode requests 480x360 and ~9 samples/second. Provider acquisition and sample work must produce a result by their deadlines and release the OS lease promptly; the current integration fixtures model those bounds, not physical performance.
- The observation shape matches `packages/gestures/src/landmarks.ts`. Reuse the existing hand ordering, monotonic timestamp rules, continuity/hold logic and transfer consent path. This worker does not classify gesture intentions, read contextual content, choose a recipient or publish a transfer.
- Future separate process integration can preserve this contract with an authenticated local event channel, bounded single-frame credits and OS-owned indicator. Never give the renderer arbitrary camera or remote transfer authority.

## Native model qualification
The same SHA-256-pinned Hand Landmarker task already used by AeRift can run without a WebView: MediaPipe 0.10.32 provides a native C ABI in its upstream [Linux and Windows x64 wheels](https://pypi.org/project/mediapipe/0.10.32/#files). The Windows DLL contains `MpHandLandmarkerCreate`, `MpHandLandmarkerDetectForVideo`, `MpHandLandmarkerClose` and image input exports. The Linux library was directly exercised locally with zero landmarks on a blank RGB frame and 21 landmarks on the pinned upstream thumbs-up photo. This is offline native model evidence, not Windows camera evidence.

```sh
python3 -I -B scripts/ambient/verify_native_landmarker.py \
  --wheel /path/to/upstream-platform-wheel.whl \
  --model /path/to/hand_landmarker.task \
  --fixture /path/to/pinned-upstream-thumb_up.jpg
```

The verifier checks artifact digests before loading, uses only its two qualification inputs, and reports counts, never poses or images. The model is [Google's Hand Landmarker float16/1](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task); the photo is Google's [upstream fixture](https://storage.googleapis.com/mediapipe-assets/thumb_up.jpg). The Python verifier is a test harness, not a runtime dependency or a bundling choice.

## Windows implementation gate
The first viable OS adapter is a video-only [Media Foundation](https://learn.microsoft.com/en-us/windows/win32/medfound/audio-video-capture-in-media-foundation) device ingress with bounded async Source Reader and explicit shutdown. Choose an explicitly authorized device; do not bypass OS camera privacy, steal a camera from another app, or open a permission dialog from a hidden worker. Pair it with a pinned, locally staged, licensed Windows C-ABI library and model; qualify the final packaging trust and runtime dependencies rather than loading anything from an arbitrary user/system search path. Keep camera frames within native memory, never in logs, network or general IPC. Bind the standalone supervisor to native lock status, priority app exclusions, battery saver and a real tray/OS camera indicator before opt-in.

Remaining validation is physical: Windows C-ABI execution, camera permissions and single-reader exclusivity, driver release on lock/pause/quit, live hand continuity with main window destroyed, frame cadence under power changes, and end-to-end capture from real Explorer without focus or network scope changes. Do not make an always-on or production gestures claim before these pass. Windows setup must continue shipping with this worker unregistered until then.
