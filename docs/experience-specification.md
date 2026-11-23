# AeRift — Governing Experience Specification

**Version:** 1.0 proposed  
**Status:** Owner-approved design direction; governing adoption pending PR merge  
**Scope:** All AeRift experiences, platforms, themes, components and future implementation work.  
**Date:** 2026-11-23

## 1. North star

> AeRift must feel lightweight, spatial, fluid, precise and almost physical. Transferring a file should feel like moving an object through space, rather than submitting a form.

AeRift transforms digital files into tangible objects that can be approached, selected, grasped, held, released and received. Sending and receiving devices participate in one continuous experience. Glass is the first visual material, not the interaction model itself. Every future theme MUST preserve physicality, continuity, spatial intelligence, expressive motion and effortlessness.

The experience MUST be sophisticated without being cumbersome; expressive without being noisy; magical without misleading the user. Every meaningful state change should be perceptible. Reliability, privacy, consent, accessibility and responsive interaction take precedence over spectacle.

This specification governs experience decisions, not wire-level protocol semantics. MUST denotes an acceptance requirement; SHOULD denotes a preferred design with documented exceptions; MAY denotes optional exploration. New features and UI changes MUST be reviewed against this document. Conflicts with safety, platform or transport contracts must be resolved explicitly, never by weakening those contracts. This document is a target, not a claim that the alpha already implements it.

## 2. Five experience areas

| Area | Purpose | Required character |
| --- | --- | --- |
| Spatial Workspace | Discover devices, choose objects and initiate transfers | Open, device-centric, responsive, uncluttered |
| Object Experience | Give files visual identity and tangible interaction | Persistent identity, apparent weight, responsive grasp and release |
| The Rift | Coordinate the cross-device journey | Continuous, expressive, truthful choreography |
| Activity | Inspect transfers, results and recovery | Practical, legible, compact, actionable |
| Control Center | Manage devices, camera, appearance and settings | Organized, contextual, accessible, unobtrusive |

These are experience boundaries, not a requirement for five separate navigation tabs.

### 2.1 Spatial Workspace

Replace the conventional form/dashboard composition with an open device-centric canvas. The local device is an anchor; paired devices are recognizable spatial targets. Discovery may use subtle rings, online targets illuminate, offline targets are subdued and unavailable for sending. Selecting a destination establishes a clear visual relationship. The canvas must distinguish discovery, trust, connectivity and explicit receive readiness; no decorative indicator may imply a device is ready when it is not.

A compact floating transfer dock integrates file selection, drag/drop where supported, ordinary Send and gesture activation. Contextual controls appear when needed rather than occupying permanent oversized cards. Provide a predictable keyboard/touch/pointer alternative to spatial targeting. Empty states should be informative, not enclosed in gratuitous panels. Preserve the working conventional transfer journey even when camera permission is denied or gestures are disabled.

### 2.2 Object Experience

A selected file becomes an identifiable visual object. Preserve file icon or safe thumbnail, identity, name and relevant size through selection, grasp, holding, transfer and arrival. Morph the same object rather than abruptly replacing it with unrelated indicators. A held capsule may compress, lift, follow the hand with damped motion and reveal details contextually. Do not imply the source file is deleted or moved on disk by visual pickup; the transfer is a copy unless a separately authorized operation explicitly says otherwise. Support clear release, cancellation and recovery. Multiple-file presentation is future scope unless supported by the actual transfer contract.

### 2.3 The Rift

The Rift is the signature cross-device experience, a temporary visual connection between trusted endpoints. It is not a separate transport and must not replace conventional progress reporting. Sender and receiver share a coherent object identity, session accent and complementary choreography. Each device renders locally; readiness on the receiving side must visibly affect the sender. Use elegant directional illumination, refraction, compression, trajectory, trails and arrival/reformation where appropriate. Avoid indiscriminate particle effects or permanent visual noise.

### 2.4 Activity

Activity is a real navigation destination, not an apparent tab that merely scrolls to a simultaneously visible dashboard panel. Use integrated list rows, clear timestamps, file/device identity, direction, actual progress, results and supported recovery actions. A compact recent-activity affordance may appear in the workspace. Pending consent, actionable errors and active transfers must remain discoverable from any view. Empty activity requires no raised inner glass card.

### 2.5 Control Center

Device management, pairing/trust, camera permissions and activation, shortcut configuration, receive destination and appearance belong in coherent contextual surfaces. Use recognizable icons with accessible names and tooltips as appropriate. Settings should be reachable without displacing the primary workspace unnecessarily. Respect platform-specific navigation, camera availability, permissions and window controls. Camera activation must be explicit and observable; provide a clear off control and expose camera ownership conflicts honestly.

## 3. Material and visual hierarchy

Preserve the investment in GLASS optics and the owner-selected Glass Laboratory recipe. Do not replace genuine transparency/refraction/reflections with opaque faux-3D panels. Apply material by semantic role instead of indiscriminately wrapping content.

| Level | Role | Treatment |
| --- | --- | --- |
| 0 | Canvas | Background, headings, ordinary text; no raised material |
| 1 | Integrated content | Rows, lists, empty states, file details; restrained separators or subtle tint |
| 2 | Interactive glass | Floating dock, navigation, buttons and selected/held objects; purposeful optical depth |
| 3 | Floating overlay | Settings, pairing dialogs, popovers; clear elevation and appropriate focus management |

Full optical surfaces MUST NOT be nested by default. A nested surface requires a distinct interaction or elevation role and explicit visual review. Child content inside glass should normally be integrated, without another refraction/shadow stack. If nesting is justified, align concentric geometry and avoid compounded blur, competing edges or illegible text. Use one consistent semantic control system (primary, secondary, quiet, destructive, disabled, busy, selected), icon family, typography scale, spacing, curvature and focus treatment. Disabled states must remain understandable and visually distinct from enabled controls. Favor compact native-app composition over oversized web headings and unnecessary page scrolling.

GLASS is the initial theme. Its optics include clear material, edge highlights, distortion, dispersion, reflections and subtle depth. Themes must implement the same semantic roles and gesture states without duplicating interaction logic. Light/dark, high contrast, reduced transparency and reduced motion must preserve hierarchy and affordances. Do not hard-code glass-specific assumptions into transfer or gesture engines. Explore integrated native window chrome only where platform behavior and accessibility remain intact.

## 4. End-to-end gesture choreography

All meaningful gesture phases MUST have distinct, understandable and highly animated feedback when full motion is enabled. Transitions must be continuous and interruptible; the displayed text must match the actual state. The following is the normative experience journey, with illustrative copy and motion rather than mandated pixel geometry.

| Phase | Sender | Receiver |
| --- | --- | --- |
| Idle / activation | Visible camera status; explicit activation; show available object and target context | Explicit receive mode and camera status when applicable |
| Open hand detected | Presence ripple, object gently lifts or highlights; “Close your hand to grab” | If an incoming object is eligible, illuminate it; “Reach out to receive” |
| Confirmed grasp | Object lifts and compresses into a held capsule; “You're holding 1 file” | A confirmed intentional receive grasp may select/authorize an eligible offer according to the trust contract |
| Held / awaiting destination | Persistent object, gentle hand-follow and clear cancel; “Waiting for receiving device” when appropriate | Ready field expands after authorized readiness; indicate waiting versus actual offer |
| Receiver ready | Sender reacts immediately to validated remote readiness; target illuminates, pathway forms, held object anticipates departure | Complementary field/ripple indicates readiness; no consent implied merely by activation |
| Intentional release | Capsule compresses, accelerates toward destination, stretches subtly and enters Rift; “Sending…” or “Waiting for acceptance” as appropriate | Corresponding arrival anticipation begins for a valid session; do not display completed receipt |
| Offer / consent | Show pending acceptance and allow cancellation where supported | Identify sender and file; deliberate accept or decline, via supported gesture or conventional control |
| Transport | Directional trail/stream and truthful progress; remain responsive | Incoming object reforms or gains definition as bytes arrive; show actual progress |
| Verification | Distinct verifying state only if backed by engine evidence; no success yet | Verify integrity and storage; keep object in provisional state |
| Delivered | Confirm successful delivery only when authoritative evidence establishes it; close Rift | Object settles into workspace; “File received”; expose file location/action |
| Cancel / failure / interruption | Controlled collapse or return to recoverable state; explain outcome and recovery | Remove provisional object or show recovery as appropriate; never show success |

Sender and receiver gesture phases may be asynchronous. A receiver grasp before actual delivery represents intent or consent, not possession of stored bytes. A readiness signal is not acceptance. A grasp on the sender is not a transfer request until deliberate release or conventional send. No actual file may be sent to an unpaired, stale or unintended target. Hand loss, accidental motion, focus changes, multiple devices, ambiguous offers and permission revocation must fail safely. Cancellation must remain available where supported; interrupted holds time out predictably and restore a clear state. Do not silently reissue an offer or resume a gesture following reconnection.

Animations should communicate anticipation, possession, readiness, release, travel, reception and resolution, not impose artificial waits. Small transfers may use a brief coherent passage; large transfers use sustained progress. If delivery completes before a decorative sequence ends, present truthful completion immediately and let nonblocking motion settle. If transport fails mid-animation, interrupt the sequence and reconcile to real state.

## 5. Shared experience architecture

Build on the existing shared React/TypeScript UI package, theme registry, GlassSurface/GlassOptics, gesture integration and Rust transport boundaries. Preserve the installable end-to-end alpha throughout migration. The following are logical responsibilities; they do not mandate unnecessary new services or packages.

- **Theme Engine:** semantic materials, optics, colors, typography and appearance tokens.
- **Motion Engine:** shared spring/damping/easing tokens, interruptible velocity-preserving transitions, shared-element morphs, trails/particles, reduced-motion behavior and quality adaptation.
- **Spatial Engine:** layout anchors, device placement, object positions and trajectories independent of transport.
- **Rift Experience Coordinator:** deterministic presentation state and cross-device choreography; maps authoritative events to local visual actions.
- **Gesture Engine:** recognizes local hand state and intentional gesture events; remains independent of rendering.
- **Peer and Transfer Engines:** authoritative discovery, trust, readiness when supported, consent, transport, integrity and completion.

Do not attach arbitrary styles to foreign gesture DOM as the long-term design; expose typed gesture feedback and render shared theme-aware components. Do not duplicate animation implementations for each platform or theme. Motion/optical parameters should be centrally tunable. A future Motion Laboratory SHOULD allow engineering adjustment of timing, stiffness, damping, velocity, trails, particles and quality with reproducible presets. Preserve Glass Laboratory presets and validate any changes against approved visuals.

### 5.1 Semantic synchronization

Coordinate with compact semantic events, never streamed animation frames. Proposed experience events include HAND_DETECTED, OBJECT_HELD, RECEIVER_READY, RELEASE_CONFIRMED, TRANSFER_OFFERED, RECEIVER_ACCEPTED, TRANSFERRING, VERIFYING, DELIVERED and terminal interruption/failure states. These are conceptual names, not existing protocol claims. Local hand state stays local unless a minimal session signal is necessary. Any protocol extension must be separately designed, versioned and reviewed against the existing contracts.

Where cross-device signals are needed, bind them to an authenticated peer, session/transfer identity and appropriate freshness/ordering semantics. Handle duplicates idempotently, reject stale readiness, reconcile out-of-order events and recover from reconnect via authoritative snapshots. Support different refresh rates, network latency and different themes without requiring synchronized clocks or frame lock. Do not transmit camera frames or hand landmarks for choreography. Avoid leaking file metadata before the authorized interaction permits it.

## 6. Accessibility, performance and platform behavior

Windows and iOS share experience semantics but adapt to screen size, orientation, touch/pointer, safe areas and native permissions. Future platforms follow the same principles. Conventional send/receive controls remain equivalent and discoverable. Keyboard focus, screen-reader announcements, readable contrast, target sizes, reduced transparency and reduced motion are acceptance requirements. Never rely solely on color, motion or sound for state. Announce meaningful changes without flooding assistive technologies.

Full-motion effects must be responsive and interruptible. Prefer compositor-friendly rendering, bounded particle counts, adaptive quality, and suspend idle/hidden work. Measure frame pacing, input-to-feedback, CPU/GPU use, memory and camera cost on representative hardware; set explicit budgets from measured baselines before release qualification. Degrade decoration before functional feedback. Never block transport, consent or cancellation on animation completion. Camera use is explicit; stop or relinquish it when required by permissions, lifecycle or user settings. No background camera assumptions.

## 7. Implementation sequence

1. Establish material roles, component consistency, semantic tokens and visual regression coverage.
2. Redesign Spatial Workspace and floating dock, with separate Activity and contextual Control Center.
3. Establish shared motion/spatial primitives and typed gesture presentation contracts.
4. Deliver local presence/grasp/held/release choreography and conventional equivalents.
5. Design and validate authenticated receiver-readiness and session coordination without weakening pairing or consent.
6. Deliver The Rift and complementary receive choreography, including actual progress, verified completion and failure.
7. Qualify adaptive Windows/iOS layouts, accessibility, physical-device behavior and performance; refine laboratories and optical presets.

Parallel work is encouraged once interfaces and ownership are established. Each merge must preserve the functioning installable alpha. No phase authorizes unrelated networking, security or protocol changes. Follow [integration ownership](integration.md) and [validation strategy](validation/strategy.md).

## 8. Review and acceptance gates

Every experience PR must identify the affected experience area(s), semantic material roles, state transitions, theme/accessibility impact, and evidence. Reviewers must reject redundant raised glass, inconsistent controls, deceptive success/readiness, inaccessible gesture-only paths, and ornamental animations that obstruct interaction. Exceptions need a documented rationale and owner review.

Minimum evidence for affected functionality:

- Light and dark screenshots at representative desktop and mobile sizes, with reduced transparency/high contrast as relevant; no gratuitous nested glass or clipped controls.
- Motion recordings for idle, hand detection, grasp, hold, readiness, release, receiving, verified success and interruption as applicable; reduced-motion equivalent.
- Physical sender/receiver recordings for cross-device claims; label simulated tests honestly and record build revisions. Show receiver activation changing sender presentation, with actual transport and integrity evidence separate from animation.
- State-machine tests for duplicate/stale/out-of-order events, cancellation, timeout, disconnect, gesture loss, ambiguous peer/offer, denied permissions and failure; no false completion or unintended send.
- Conventional keyboard/pointer/touch transfer and explicit consent remain functional. Screen-reader/focus behavior is verified where supported.
- Performance traces against agreed device budgets; animations do not delay operations or hide errors. No regression of existing transfer contracts or build qualification.

A screenshot alone does not establish optical fidelity, motion quality or synchronized behavior. Automated checks supplement, not replace, real-device review. A feature may land incrementally with explicit limitations, but must not claim full experience acceptance until relevant gates pass.

## 9. Decision rule

When choosing between two designs, prefer the one that makes the object, intent and destination clearer while reducing visual clutter and preserving continuity. Use glass where it conveys interaction or elevation. Use motion where it conveys state and physical relationships. Preserve honest feedback and explicit intent even when a more spectacular animation is possible.

The goal is not a dashboard with attractive cards. The goal is a coherent spatial experience in which moving a file feels almost physical.
