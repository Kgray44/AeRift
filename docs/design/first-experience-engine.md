# AeRift First Experience Engine (FEE)

Status: Proposed governing design; implementation requires integration review.
Scope: Windows, iOS, future macOS, Linux and Android. This is a design contract, not evidence of implemented behavior.

## 1. Intent

The first launch is the awakening of a spatial environment, not a slideshow or setup wizard. AeRift should communicate effortless, intentional, local-network sharing through continuous motion, tangible objects and restrained Liquid Glass. The experience must never obstruct the user's primary purpose: transferring files. No mandatory account, music, forced tutorial, artificial wait, marketing screens or upfront permission barrage.

## 2. Welcome and continuous assembly

1. Open into a minimal theme-aware environment. A restrained light ripple and optical distortion reveal the AeRift mark.
2. Materialize a localized greeting (Hello, Bonjour, Ciao, Hallo are illustrative); optional brief multilingual cycling settles into the user's language. Use real localization, including RTL and dynamic text. Do not require cycling to finish before proceeding.
3. Offer Begin and a readily accessible Skip introduction action. Both work as soon as the shell can accept input.
4. On Begin, transform the mark into the desktop navigation anchor or mobile navigation structure using shared-element continuity. Glass surfaces grow from coherent origins; workspace tools and icons settle into place. On desktop, the mark becomes the radial menu anchor; on mobile it resolves into the bottom navigation. A fallback target is required until the corresponding navigation implementation lands.
5. Reveal actual discovered devices and files as their respective services become ready. Empty, denied, offline and failed states remain honest. Never fabricate real device discovery or hold a ready interface hostage to animation.

Motion budget (illustrative targets, not mandatory waits):

| Beat | Target |
| --- | --- |
| Illumination | 0.50 s |
| Greeting | 1.80 s |
| Symbol transformation | 0.65 s |
| Workspace assembly | 0.85 s |
| Settling | 0.40 s |

Nominal sequential total 4.20 s, excluding user interaction. Overlap where natural; allow interruption at every point. Startup initialization begins independently of choreography. Render usable controls as soon as ready; slow services get local progress or retry affordances. No artificial loading percentages. Use existing shared glass/motion primitives, with consistent material hierarchy, subtle blur, reflection and theme-appropriate contrast. Do not introduce a separate renderer.

## 3. Contextual tour

Offer an optional tour inside the actual functioning shell. A lightweight anchored glass explanation highlights a relevant control without obscuring it. Avoid nested cards, large overlays, forced navigation or fake screenshots. Users can choose Next, Back, Exit tour, or interact with the highlighted control where appropriate. Escape on desktop and accessible dismissal on mobile must work; exit always leaves a usable shell. Never trap focus except where a genuinely modal native permission prompt requires it.

| Step | Objective | Completion |
| --- | --- | --- |
| Explore | Discover radial navigation or mobile bottom tabs | Open a destination or advance |
| Discover | Understand nearby devices and explicit pairing approval | View discovery and pairing explanation |
| Collect | Select files/photos or supported objects | Select a demo object or advance |
| Cross the Rift | Learn transfer and synchronized visual feedback | Complete or skip isolated simulation |
| Personalize | Discover themes, workspace options and gesture settings | View settings or finish |

Demo mode must be visibly labeled, use synthetic objects and a synthetic peer, and never invoke real transfer, pairing, discovery identity or permission side effects. Demo events must not appear in real activity or trigger the first-real-transfer milestone. Users with no peers can still complete the tour. Explain conventional sending first. Do not gate real app use on completion.

## 4. Optional gesture introduction

Gesture controls remain disabled unless explicitly enabled in Settings. No giant gesture activation button in the workspace. Only after enablement offer the optional training/calibration flow; request camera permission just in time, explain use and show actual camera/tracking state. Demonstrate reach/open hand, intentional grasp, and release with animated object feedback according to the established gesture contract. Use an isolated simulated transfer; no actual sending during calibration. Provide recognition feedback, retry, cancellation, conventional-control alternative and a clear exit. Permission denial, unavailable camera, low recognition confidence or camera ownership conflicts cannot block ordinary transfers. Stop camera resources when the tutorial exits unless an independently authorized active session requires them. Preserve the existing gesture safety and intentionality rules.

## 5. First real crossing

After the first confirmed successful real transfer on this installation/profile, show a short nonblocking message, “Your first crossing.” Optional supporting copy: “Distance is no longer a boundary.” Resolve naturally from the transfer animation, then return to the workspace. Do not show on queued, failed, canceled or demo transfers. Persist acknowledgement; deduplicate repeated completion events. No confetti, sound or forced dismissal. This is a milestone, not a new transfer protocol state.

## 6. Platform adaptations

| Aspect | Desktop | Mobile |
| --- | --- | --- |
| Welcome | Expansive canvas, responsive to window size | Intimate full screen, safe-area aware |
| Assembly | Radial anchor and optional expanded workspace | Bottom navigation and integrated workspace |
| Tour | Anchored floating explanations, keyboard/mouse | Touch-friendly anchored explanations, swipe where appropriate |
| Tools | Show only enabled workspace tools | Introduce supported files, photos and other tools as available |
| Lifecycle | Window resize, focus and multi-window handling | Backgrounding, rotation, safe areas, native permission flows |

Share semantics, localization, design tokens, state machine, timing policy and accessibility behavior. Platform shells own placement and native lifecycle. Do not advertise unreleased platform capabilities.

## 7. State and persistence

Recommended conceptual states: uninitialized → welcome → assembling → shell-ready; tour is an independent optional state (not offered / offered / active(step) / dismissed / completed); gesture tutorial and first-crossing milestone are independent. These are conceptual contracts, not mandated APIs.

Persist a versioned local record containing introduction status, tour step/status, gesture tutorial status and first-crossing acknowledgement. No camera frames, file content or peer identifiers in onboarding state. Write transitions atomically; repeated events are idempotent. Interrupted welcome/assembly resumes to a usable shell; interrupted tour may offer Resume or restart, never automatically lock the user into an overlay. An explicit dismissal persists. Settings offers replay of the introduction and individual tutorials without resetting permissions, preferences, real activity or milestone state. Upgrades do not rerun onboarding automatically; new optional feature tips may be offered separately.

Normal launches bypass the introduction. A short nonblocking shell transition is permissible if it does not delay interaction. Corrupt or missing state must degrade to usable shell and optional recovery, not a crash loop. Concurrent windows must not duplicate milestone or mandatory onboarding.

## 8. Accessibility, performance and privacy

Respect OS reduced motion and app motion preferences; use immediate placement or short opacity changes instead of spatial travel, refraction or parallax. Support screen readers, keyboard focus order, visible focus, scalable text, contrast, touch targets, RTL, light/dark and live appearance changes. Do not convey readiness solely by color or movement. Avoid flashing. Keep Skip and Exit accessible through transitions. On low performance, simplify effects rather than delay readiness; release transient rendering resources. Test startup responsiveness and animation frame pacing on representative physical devices; record actual measurements rather than claim a fixed FPS. Request permissions only for a user-selected capability. Keep onboarding local; diagnostics, if any, must follow existing privacy controls and contain no file names, camera images or peer identities.

## 9. Integration and ownership

Follow [integration ownership](../integration.md), the existing typed app port and protocol. FEE owns experience orchestration and local onboarding state; shared UI owns glass, motion and reusable primitives; navigation tracks own actual destination anchors; desktop/mobile tracks own shell layout and lifecycle; gesture track owns recognition/calibration behavior; transfer engine owns real completion and pairing truth. No duplicate renderer, gesture engine or transport. Agree on semantic readiness events, anchor registration, cancellation and completion event adapters before modifying shared contracts. Coordinate package registration, dependencies and lockfiles with Integration. Prefer a shared controller and platform adapters; exact paths and interfaces are to be agreed in implementation PRs.

Suggested implementation order: (1) persistent state and shell readiness/cancellation tests; (2) shared welcome and assembly with fallback anchors; (3) platform anchor integration; (4) optional contextual tour and isolated demo; (5) gesture tutorial adapter and milestone; (6) native accessibility, performance and end-to-end qualification. Keep installable file-transfer behavior intact throughout.

## 10. Acceptance gates

- Fresh install shows localized theme-aware welcome; Begin and Skip work during every visual phase; a skipped intro reaches a correct shell without stale overlays or orphan animations.
- Desktop/mobile assembly targets actual navigation where available; resize, rotation, backgrounding and theme changes do not strand controls.
- Slow initialization, offline discovery, no peers and unavailable permissions present truthful states and conventional transfer remains reachable.
- Every tour step can be exited; back/next and supported real-control interactions work; replay and resume preserve preferences.
- Simulated transfer cannot send, pair, alter real history or trigger milestone.
- Gesture tutorial is opt-in, permission-aware, cancelable and releases resources; conventional transfer works with camera denied.
- Exactly one first-crossing acknowledgement per persisted scope after real confirmed success, including duplicate-event and restart tests.
- Relaunch skips completed/dismissed onboarding; corrupted state and upgrades recover without forced repeat.
- Reduced motion, screen reader, keyboard, contrast, text scaling, safe areas and both appearance modes qualify.
- Validate controller transitions with automated tests, platform integration with UI tests, and first-launch/real-transfer behavior on physical Windows and iOS devices. Record source revision, results, performance observations and any unverified platform scope before claiming completion.

## 11. Non-goals

No account system, cloud relay, new transport protocol, mandatory walkthrough, permission bypass, artificial loading sequence, competing glass/motion engine or implementation of the radial/mobile/desktop redesign within this documentation change.
