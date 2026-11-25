# Windows Ambient Explorer camera pickup: qualification candidate

Base: Kgray44/AeRift main 752708709f71e0776f504a49d0daec164272a357. The only
staged implementation is the new private
`apps/aerift/src-tauri/src/ambient_runtime/explorer_gesture.rs` module. It
does not instantiate Media Foundation, choose a device, enable any new
setting, call a Shell API, record landmarks or frames, or send a transfer.

## Exact seam

- `ambient_native_model.rs` uses the pinned local MediaPipe model, resolves
  up to two hands and returns one 21-landmark hand only when unambiguous.
  `ambient_media_foundation.rs` owns video ingress and independently checks
  its native grant at preflight, acquisition and sample.
- `CameraSupervisor` (transfer crate) owns the camera and RAII indicator,
  exposes a replacement-only fresh landmark mailbox, and drops the lease
  before dropping the indicator. The app does not mount this camera in the
  shipped runtime. The normal product's foreground camera is separate.
- The new detector mirrors the shared front-end open (200 ms) and fist (130
  ms) dwell, at least three new samples per step, palm continuity, 220 ms
  maximum gap, 150 ms sample freshness and a three-second armed window.
  It emits only a single-consumption permit for the exact foreground anchor
  and live camera context, not a send, file path, or destination.
- Existing `AmbientRuntime::request_pickup` anchors the current foreground,
  resolves its exact selected items using native Explorer COM, asynchronously
  freezes supported files with the existing policy and generation checks,
  and emits the reviewable capture slot. The native gesture entry needs a
  variant that admits the already-bound anchor and opt-in epoch, and does
  not resample a substitute on mismatch. Apply those checks before
  mutation and revalidate capture generation while hashing and before slot
  publication. A failed gesture admission must not clear a previous slot.
- `hold_a4_native_pickup` consumes only an exact, recently frozen,
  v1-representable slot and only with separate A4 opt-in. Do not have
  the camera call the Nearby Drop API, choose a peer, or accept a transfer.
  Existing native A4 hold/drop and recipient acceptance stay distinct.

## Required qualification, not enabled by this patch

The native session owner, not a renderer permission or status string, must
construct `ExplorerCameraContext<CaptureAnchor>` only after an explicitly
chosen Media Foundation device, current OS camera permission, visible native
indicator, current camera lease, interactive unlocked desktop, exact Explorer
foreground/focus and Ambient Explorer camera opt-in are all known. The epoch
must be incremented and the mailbox cleared/replaced on any interruption
(permission, camera restart, mode/lease, pause, foreground eligibility,
reconfigure, lock, shutdown); active_since must be monotonic and reflect the
new context. Feed `None` when any requirement is unavailable. Never scan
selections at camera frequency. Poll scoped native foreground identity and
only enter COM once after claim. Verify no suspended/stale/replaced generation
can reach the capture slot, including switching away and back between samples.
Do not guess a permission API, silently auto-select cameras, or weaken the
pinned native DLL/model validation to enable this feature.

Include as a private module under the existing Windows
`ambient-media-qualification` feature for first compilation. Exercise with
synthetic landmark poses on disposable Windows CI; do not open a camera in
unit tests. Verify formatting, tests, and existing keyboard path. For
production, still qualify pinned package staging/model licensing, an OS
camera chooser, reliable OS session observer and visible native indicator on
real Windows; confirm camera close/pause/revocation, Explorer tab/selection
changes and supported app identity; do the real opt-in Explorer/fist/paired
device/explicit accept test on owner-authorized hardware. Passing synthetic
tests is not evidence of real camera or transfer behavior.
