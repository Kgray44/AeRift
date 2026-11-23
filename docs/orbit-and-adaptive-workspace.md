# AeRift Experience Design: Orbit and Adaptive Workspaces

Status: proposed governing experience addendum for review

Date: 2026-11-23

Scope: iOS, Android, Windows, macOS and Linux target experiences; platform capability and release qualification remain separate.

## 1. Purpose and governing principles

AeRift is a shared digital space across devices, not merely a file transfer utility. Digital things should feel tangible; navigation should feel spatial; transitions should feel continuous; devices should feel connected. Preserve the existing working Windows/iPhone transfer path and security boundaries described in [the project README](../README.md), [integration](integration.md) and [protocol](../contracts/v1/protocol.md). This document extends experience direction, not wire-protocol authority or evidence of shipped functionality. Reconcile it with the governing experience specification before implementation; do not silently override existing security or accessibility requirements.

The experience comprises Spatial Workspace, Object Experience, Rift, Activity and Control Center. Orbit is the desktop navigation mechanism connecting those areas, not an additional transfer subsystem. Portable, immersive and ambient experiences share identity and semantics while adapting to platform conventions.

## 2. Orbit: desktop primary navigation

Replace the persistent left sidebar in the default desktop presentation with a compact upper-left current-destination Liquid Glass orb and readable destination label. Clicking the orb opens a quarter-circle fan extending rightward and downward. Other top-level destination icons emerge from behind the current orb into stable angular slots; the current destination is not duplicated. Keep labels legible, hit targets distinct, and the fan within the actual available window bounds. Maintain predictable destination ordering and adapt radius, spacing and placement to window size, DPI and text scaling. Use a conventional accessible navigation fallback when space or preference requires it.

Simplified destinations: Home, Rift, Devices, Activity, Settings. Full adds Workspace. Workspace modules belong inside Workspace, not in the primary fan; a secondary compact navigation control may be explored without requiring nested radial menus. Settings is always reachable. No navigation item activates camera recognition.

### Interaction lifecycle

1. Rest: current page icon in a clear optical orb, with subtle edge refraction and a readable label. Avoid constant distracting motion.
2. Expand: sibling destinations emerge sequentially along an arc with spring-like settling; the existing page remains recognizable and may gently recede. Background treatment must not destroy readability.
3. Hover/focus: modest scale increase, cursor-reactive highlights, gentle neighbor displacement without changing stable hit targets, and prominent label. Optional delayed destination preview must not steal focus.
4. Select: selected orb briefly compresses, then expands into the actual destination surface. Interpolate bounds, corner radius, optical depth, refraction and content reveal. Preserve visual identity through the transition; avoid merely fading unrelated pages. Other orbs retract; prior page recedes. Commit navigation once, restore destination focus, and update the persistent orb.
5. Settle: new page interactive with its own current-destination orb; no redundant animation lockout. Back navigation should maintain continuity where feasible.

Escape/outside click dismisses without navigation; repeated activation toggles the menu. Keyboard shortcuts, directional navigation, Tab/focus order, Enter/Space and accessible names must work independently of pointer hover. Screen readers announce expanded state and destination changes. Reduced motion uses short opacity or direct transitions with identical semantics. Provide conventional navigation preference. Optional press-and-drag selection is exploratory, not a prerequisite; require deliberate release and cancellation. Live badges may indicate actual transfers or connected devices, never fabricated status.

### Motion starting points (not fixed acceptance thresholds)

| Motion | Initial duration |
|---|---:|
| Fan expansion | 340 ms |
| Entrance stagger | 28 ms |
| Hover response | 140 ms |
| Selection compression | 85 ms |
| Orb-to-page morph | 460 ms |
| Content emergence | 220 ms |
| Dismissal | 260 ms |

Overlap stages rather than summing them; tune on real hardware. Use interruptible spring/velocity-aware transitions, immediate input acknowledgment, and deterministic route state. No stale callbacks, duplicate navigation, dropped inputs, or forced waits. Handle resize, focus loss, rapid selection, theme changes and interrupted transitions. Prefer composited transforms where practical and measure frame pacing at supported display rates. If a shared-element transition is unavailable, preserve functional navigation with a restrained fallback.

## 3. Shared material and motion system

Use the same Glass Engine, Motion Engine, design tokens, icon family and object representation across platforms where feasible, with platform adapters rather than independent visual inventions. Light, dark and system-following themes are first-class. Both themes require contrast, legibility and tested appearance over varied backgrounds. Glass is optically clear with slight blur, rounded optical edges, localized reflection patches, restrained dispersion, depth and distortion; avoid opaque bevels or flattened fake-3D lips. Respect the approved glass recipe and existing renderer ownership. Orb material has stronger local lens behavior than broad page surfaces; interpolate depth, magnification, reflections, corner radius and distortion during morph. Broad surfaces prioritize legibility. Support reduced transparency and lower-cost rendering fallback.

## 4. Mobile: portable full workspace

iOS and Android default to a complete, touch-first workspace with a floating bottom navigation bar respecting safe areas, keyboard and accessibility insets. Proposed five destinations: Home (devices, recents, shortcuts), Workspace (modules), Rift (spatial transfer environment), Devices (pairing and management), Activity (progress/history/recovery). Settings remains in an obvious upper corner. The Rift tab opens an environment, never a gesture enable button. Adapt to tablets and rotation without copying the desktop layout verbatim.

Workspace modules: Files (native providers/import, previews, organization), Photos and Videos (permission-scoped library, original-quality transfer and metadata options), Browser (lightweight web capture, links and downloads), Notes (quick text, snippets, attachments), Clipboard (explicitly opt-in sharing/history/pins), Collections (heterogeneous object grouping). Provide module visibility preferences and sensible empty states. Preserve data when hidden. Do not claim unrestricted filesystem, photo, clipboard or background camera access; respect OS permissions and lifecycle. Browser must use supported platform web technology and isolate untrusted content, handle external links and downloads safely. Notes are transfer-oriented, not a full productivity suite.

## 5. Desktop: adaptive immersive and ambient experiences

Windows, macOS and Linux target the same desktop semantics with platform-specific integration and qualification.

- Simplified (default): Home, Rift, Devices, Activity, Settings; native drag/drop, send/receive, connected devices, gesture status, transfer history, and tray/menu-bar presence where supported. No persistent sidebar in Orbit mode. No need to adopt AeRift as the user's browser or file manager.
- Full Workspace (optional): adds the same workspace modules as mobile, adapted to larger windows, multi-selection, keyboard, larger working surfaces and responsive layouts. Modules can be individually hidden/reordered where appropriate.
- Ambient (orthogonal runtime presentation, not a third mutually exclusive data mode): tray/menu-bar popover, native file context actions, configurable shortcuts and transient transfer/gesture overlay where supported. Main window need not be open. Do not infer support on every desktop environment; provide explicit fallbacks. Camera use requires configured activation and visible status; release camera on competing application request if enabled and supported.

Settings expose Simplified/Full, module visibility, navigation preference, Light/Dark/System, gesture configuration and camera behavior. Switching layout/theme must not delete objects, reset pairings, interrupt transfers or restart the service. Keep module data and transfer engine independent of presentation. Shared state is not a promise of automatic remote synchronization: any cross-device sync must be explicitly designed, permissioned and secured.

## 6. Unified digital object architecture

Workspace modules produce typed objects, the Rift transports supported representations, and the destination resolves safe open/save/import actions. Object types may include files, images, video, URLs, text, notes, clipboard entries and collections; future structured types require explicit capability negotiation. Define stable identity, type/schema version, metadata, preview, selection/grouping, provenance, payload references and transfer lifecycle. Collections preserve manifest ordering and per-item integrity; partial failure is visible and recoverable. No arbitrary code execution or automatic opening of untrusted content. Do not change the v1 protocol silently: introduce versioned capabilities and compatibility tests before transporting new types. Avoid copying data unnecessarily, preserve existing file transfer interoperability, and distinguish local workspace persistence from remote device storage.

## 7. Gesture and Rift choreography

Gesture recognition is enabled only through Settings, never a giant activation button in Home, Rift or Workspace. Contextual indicators communicate permission, camera state, ready, paused, unavailable and recognition confidence as appropriate. Conventional transfer controls remain available. On desktop allow configurable camera activation keybind and optional camera relinquishment to other apps where supported. Respect foreground/background restrictions on mobile.

When active, guide the user through hand detected, ready to grab, object targeted, fist/grab confirmed, held object, destination acquisition, intentional release/send, receiving, arrival and completion. Animate object pickup, movement, compression/release, departure and receiving-device emergence as one coherent journey; collection arrivals may unfold into constituent objects. Show cancellation, ambiguity, lost tracking, rejection, connection loss, progress and recovery honestly. Visual events must follow authoritative transfer state, never imply delivery before verification. No accidental sends on ambiguous gesture; preserve consent and pairing requirements. Camera capture and clipboard are privacy-sensitive; minimize retention and avoid unnecessary transmission, provide explicit permission and revocation controls. Never activate camera merely by opening Orbit or navigating.

## 8. Implementation sequence

1. Preserve and qualify the existing barebones end-to-end path on physical Windows and iPhone devices; retain regression fixtures.
2. Establish shared theme/material/motion contracts and adaptive shell; prototype Orbit independently of transport.
3. Integrate Orbit and mobile bottom navigation, desktop mode preference and accessible fallback without changing transfer semantics.
4. Introduce versioned object model with existing file/photo support first; qualify compatibility.
5. Integrate gesture choreography with actual transfer state; verify interruption and failure handling.
6. Add notes, clipboard and browser incrementally with permission and security reviews.
7. Add heterogeneous collections, deeper native integrations and ambient overlays; qualify each supported platform separately.

Parallelize independent work behind stable contracts, but integrate incrementally and preserve a runnable app. No claim of Android/macOS/Linux implementation solely from this roadmap. Avoid scope creep into full office suites, unrestricted file managers, browser engines or automatic cloud sync.

## 9. Acceptance and evidence

- Orbit: correct stable destinations for each mode; fan fits supported window sizes and scaling; pointer, touch where relevant, keyboard and screen-reader navigation; selected orb visibly morphs into the destination; no clipped labels, accidental route changes or focus traps. Capture recordings for light/dark and reduced-motion variants.
- Motion: rapid selection, dismissal, resize, theme change and interruption converge to the correct route with no stranded overlays; measure frame pacing and input-to-visible response on real hardware, documenting device and build.
- Mobile: bottom navigation, safe areas, keyboard, rotation, permission denial/revocation and module visibility work; settings reachable and no gesture-enable CTA outside settings.
- Desktop: Simplified/Full switching preserves state and active transfers; native actions and ambient lifecycle are validated per OS; closing a window does not imply background functionality where unsupported.
- Object/Rift: real file/photo transfers still work both directions; verify integrity, cancellation, failures, reconnect and recovery; new types negotiated explicitly. UI never announces success before verified state.
- Security/privacy: pairing approval, authenticated transport, safe destination handling, explicit camera/clipboard permission, no silent sharing. Test locked/denied states and revocation.
- Design: consistent visual identity and readable light/dark/system themes across qualified platforms, slight glass blur, accessible contrast and no permanent sidebar in default desktop Orbit mode.

Review evidence should distinguish mockups, automated tests, platform simulator tests and physical device results. Documentation approval is not implementation acceptance.
