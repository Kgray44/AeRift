# AeRift desktop and iOS motion

This pass follows the existing [experience specification](../experience-specification.md).
It starts from the exact glass recipe; there is one timing vocabulary, not one
animation for every event. Routine responses are quick; only Orbit and Rift get
spatial choreography. Focus, consent, transfer state, and file operations are
always independent of the animation clock.

| Surface | Coverage in this pass | Behavior |
|---|---|---|
| Desktop routes | Home, Rift, Devices, Workspace, Activity, Settings | Direct navigation uses the shared short reveal without replacing persistent controllers. Pointer selection in Orbit keeps the unfolding morph without stacking a second entrance. Keyboard and assistive activation keep the new heading visible immediately. |
| Desktop workspace and controls | Modules, native disclosures, item selection, existing press and focus | Newly shown content gets a brief reveal. State and keyboard focus remain independent. |
| iOS routes and dock | Home, Workspace, Rift, Devices, Activity and Control Center | Reveals follow dock direction (and mirror in RTL); dock selection uses matching timing. Fixed dock, camera and transfer controllers stay mounted; rapid navigation keeps the last intended route. |
| iOS workspace | Module switches, Files and Photos, note and collection disclosures, selection and confirmation | Direction and feedback follow the same short motion. Native editing and picker presentation are not reanimated. |
| Shared overlays and feedback | Settings/pairing sheets, anchored popovers, swipe dismissal and notices | Where the WebView supports discrete top-layer transitions, the visual exit continues without blocking focus or action. Older WebViews use an entrance and immediate native close. |
| The Rift | Selection, receipt-driven progress, verification, delivery, cancel/failure and retry | Shared easing connects the spatial and compact paths; compact travel uses a transform. Actual byte receipts move progress; 100% byte count is still not delivery. |
| Glass and appearance | Live motion, settling, light/dark, reduced modes | Moving shapes carry a local translucent WebView material rather than leaving a stationary reflected duplicate. Settled shapes use the exact optical recipe. Appearance and geometry are interruptible; no perpetual idle repaint or synthetic motion on reduced settings. |

## Reproduce

Run `npm run test:ui`, `npm run test:gestures`, `npm test`, and
`npm run build --workspace @aerift/app`. The browser fixture build is
`tests/ui/dist`. Use `desktop-visual.html?route=rift&motionFixture=1` or
`mobile.html?motionFixture=1`. Query opt-in exposes **fixture-only**
`window.aeMotionFixture.set(direction, phase)`; ordinary previews and the
packaged app do not expose it. The fixture dispatches mock snapshots through the
existing port, not real transfers. Confirm the labels and visual phase at
acceptance, partial bytes, all bytes before receipt, confirmed delivery,
interruption and retry.

Browser QA does not qualify physical iPhone WKWebView, Windows WebView, camera
activation, two-device travel, or sustained frame rate. Measure those with
matching builds and real hardware before making release acceptance claims.
