# AeRift Ambient Experience, A5–A7

This candidate extends the Windows Ambient foundations without enabling background camera capture. The manual transfer path, current iOS/Android camera behavior, and Nearby, My Devices, Remote and Friends authorization boundaries remain unchanged.

## A5: read-only Glass overlay

On Windows, explicitly choose **Show transfer preview** in the enabled AeRift tray for a single in-progress receipt, including while the main WebView is hidden. Empty/ambiguous transfer state does not create a visible overlay. The native host opens a transparent, no-focus, click-through tool window; it fails closed if input suppression cannot be configured. The position is one of four configurable corners in the active monitor work area (bottom-right default), using its physical bounds and DPI scale, refreshed during the bounded inspection. Lock, unknown foreground, Ambient exclusions and screen-covering foreground windows suppress it. Physical focus, gaming/fullscreen variants, reconfiguration and mixed-display behavior still require an approved hardware qualification.

The surface loads the production Glass Engine and the approved recipe directly. Its optics sample AeRift's decorative field only; there is no desktop or foreground-app capture. The surface uses AeRift's theme and motion tokens, coordinated orbit/breathing feedback, terminal dissolve, and system and app reduced-motion preferences. No continuous effect is mounted on idle. Receipt updates use the existing native watch channels, coalesce over 80 ms and send nothing when unchanged; when visible, a 500 ms native placement check is bounded to 60 seconds. The completion tail is 1.1 seconds and never gates the transfer. These are timing design bounds, not measured Windows frame pacing.

The versioned app-contract consumer can display one opaque interaction from a trusted producer, including late or coalesced milestones. It rejects malformed, regressive, duplicated and terminal replay, and requires the trusted adapter's verified completion. It projects safe status/count/progress only, never payloads, paths, URL/title, landmarks or device identifiers. A host supplies the authoritative subscription boundary for session replacement. The current Windows adapter is a receipt producer only; it does not invent camera or A4 session events. End-to-end gesture recognition, object previews, source/destination animation clock synchronization and mobile consumers remain gated on A4, future product adapters and physical qualification.

## A6 / A7 boundaries

- [Browser bridge](ambient-a6-browser.md): Chrome/Edge explicit extension action and local one-shot native qualification; selected plain text and sanitized URL references are supported in fixtures. Neither live browser installation nor trusted handoff into the shipping app has been completed. No automatic pickup, rich/multiple-object content, arbitrary bytes/downloads, or browser-to-peer sending is exposed.
- [Contextual receiving and Inbox](ambient-a7-inbox.md): Windows user selects **Accept to Inbox** for a regular v1 file. Storage choice is frozen during receiver admission; bytes are verified and metadata persisted before completion. Ordinary receive still uses its configured folder. No automatic foreground writes, URL opens, commands, mobile Inbox, or cross-scope authority. Resumable Inbox admission is deliberately refused pending one shared atomic checkpoint contract; it never changes the selected target silently.

## Release gates
The disposable Chromium job injects only native display events, tests dark/light/reduced-motion and true idle teardown, and reports 45 requested-animation-frame gaps by color scheme. These are synthetic renderer intervals, not native Windows composition, display scanout, camera latency or end-to-end transfer performance.

Use exact-tree Foundation, native Windows installer/launch (including no-activation UI behavior), iOS and Android checks, plus the pinned Windows browser-native-stdio qualification. Gate any expanded desktop overlay or browser permissions on separate interactive fixture verification. Full physical scenarios (Explorer pickup to iPhone, image bytes, app inserts, and true simultaneous A4 animation) are not established by these tests.

### Ambient material boundary

An explicitly supplied AeRift-owned 144×104 backplate uses the same `shadeLens` distortion, magnification, color dispersion, reflection and softening math as the app's Glass surfaces, then clips that result to the moving liquid silhouette. There is no framebuffer readback or backdrop capture. The native Windows overlay does not own an image of other windows or the desktop and therefore shows real transparency with the shared recipe's specular and edge profile, not a fabricated claim of desktop distortion. Compact status and count sit inside the safe center without a panel or pill.
