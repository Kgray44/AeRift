# Spatial experience validation

The screenshots use the production build of the development showcase at 1280 × 800 in Edge and 393 × 760 in phone-width WebKit. The fixture feeds synthetic hand observations through the shared gesture recognizer and uses an in-memory transfer port. Native loopback and packaged launch checks use separate test environments.

| State | Dark | Light |
| --- | --- | --- |
| Workspace with online and offline peers | [Dark](evidence/spatial-experience/dark-idle.jpg) | [Light](evidence/spatial-experience/light-idle.jpg) |
| Discovery | [Dark](evidence/spatial-experience/dark-discovery.jpg) | [Light](evidence/spatial-experience/light-discovery.jpg) |
| Selected object and camera listening | [Dark](evidence/spatial-experience/dark-selected-listening.jpg) | [Light](evidence/spatial-experience/light-selected-listening.jpg) |
| Hand detected | [Dark](evidence/spatial-experience/dark-hand-detected.jpg) | [Light](evidence/spatial-experience/light-hand-detected.jpg) |
| Grasp held and receiver ready | [Dark](evidence/spatial-experience/dark-held-ready.jpg) | [Light](evidence/spatial-experience/light-held-ready.jpg) |
| Rift departure | [Dark](evidence/spatial-experience/dark-departure.jpg) | [Light](evidence/spatial-experience/light-departure.jpg) |
| Byte-driven progress | [Dark](evidence/spatial-experience/dark-transferring.jpg) | [Light](evidence/spatial-experience/light-transferring.jpg) |
| Sender delivery | [Dark](evidence/spatial-experience/dark-delivered.jpg) | [Light](evidence/spatial-experience/light-delivered.jpg) |
| Receiver holds the pending offer | [Dark](evidence/spatial-experience/dark-incoming-held.jpg) | [Light](evidence/spatial-experience/light-incoming-held.jpg) |
| Receiving | [Dark](evidence/spatial-experience/dark-receiving.jpg) | [Light](evidence/spatial-experience/light-receiving.jpg) |
| Verified receipt | [Dark](evidence/spatial-experience/dark-received.jpg) | [Light](evidence/spatial-experience/light-received.jpg) |
| Activity | [Dark](evidence/spatial-experience/dark-activity.jpg) | [Light](evidence/spatial-experience/light-activity.jpg) |
| Control Center | [Dark](evidence/spatial-experience/dark-control-center.jpg) | [Light](evidence/spatial-experience/light-control-center.jpg) |
| Pairing | [Dark](evidence/spatial-experience/dark-pairing.jpg) | [Light](evidence/spatial-experience/light-pairing.jpg) |
| Recoverable send error | [Dark](evidence/spatial-experience/dark-error.jpg) | [Light](evidence/spatial-experience/light-error.jpg) |
| GLASS Laboratory | [Dark](evidence/spatial-experience/dark-laboratory.jpg) | [Light and high-contrast detail](evidence/spatial-experience/light-laboratory.jpg) |
| Phone-width workspace | [Dark](evidence/spatial-experience/mobile-dark-workspace.jpg) | [Light](evidence/spatial-experience/mobile-light-workspace.jpg) |

Phone-width WebKit also showed the [Rift](evidence/spatial-experience/mobile-light-rift.jpg) and the [reduced-motion and reduced-transparency fallback](evidence/spatial-experience/mobile-reduced-motion-transparency.jpg).

Appearance changes preserved held object identity, destination, camera intent, navigation, and an active mobile receipt. System changed live with the browser’s emulated OS preference. Explicit appearance survived reload. A separate replay checked that Control Center preserves an existing hold while blocking new attempts and transfer commands. Native tests exercised paired TLS, the readiness lease, explicit consent, shared IDs, verified saves, and compare-and-clear selection.

## Rendering measurements

During one 2.75-second active-transfer replay per appearance, desktop Edge reported 6.2 ms p95 between animation-frame callbacks in both modes. The longest observed gap was 12.3 ms in Dark and 6.3 ms in Light. A separate 1440 × 900 Chromium measurement showed a median optical canvas pass of 7.4 ms at idle and 7.6 ms during a readiness transition. Settled reduced motion produced zero periodic optical paints during an 800 ms sample. These are browser measurements on the development host. Physical camera, GPU, battery, and cross-device performance require supported hardware.
