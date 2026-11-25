# AeRift Liquid Glass motion pass

Motion is an operation's feedback, not decoration that delays the operation.
This pass keeps the existing AeRift theme, CSS motion tokens, native dialog
lifecycle and verified transfer state. It adds a scoped Motion for React
provider with lazily loaded gesture/projection features, not a second UI theme
or transfer state machine.

| Surface | Intended motion | Avoid |
| --- | --- | --- |
| Workspace cards | Glass symbol lifts, chevron advances, release settles; opening a card shares its symbol with the selected workspace heading. | Moving the interactive hit target or making dark/light materials diverge. |
| Native Sheet / Popover | One clipped light sweep moves around the Glass edge, complements existing anchored entry and then stops. | Delaying native focus, Escape, consent, dismissal or close. |
| Phone Friends | Active list/detail panes move directionally with an inert, inaccessible departing pane. Back focuses the originating friend. | Duplicate input targets, focus parked in departing UI, wrong direction in RTL. |
| Shared controls | Press compresses briefly, release has a longer settle, focus is immediate, card highlight interpolates. | Continuous idle animation or replacing native keyboard semantics. |
| Desktop direct route | A completed route stops its timer even if another CSS effect continues. Existing Orbit remains the desktop navigation choreography. | Replaying a route during focus/appearance changes. |

App setting, OS reduction and backgrounding suppress spatial feedback. Existing
Glass materials and transfer optics remain authoritative. Never animate success
before actual verification, and never keep a permission or consent interaction
active simply so it can animate out.

## Validation
- Run production app build and shared UI tests (no hardware required).
- Hosted Chromium checks the card's real spring transform without a moving
  button target, keyboard/focus/route uniqueness, two reduced-motion controls,
  desktop video evidence, LTR/RTL mobile Friends and rapid reversal.
- Compare baseline and candidate JavaScript transfer sizes with the same
  toolchain. Keep projection features in a separate chunk; this does not prove
  startup CPU or physical-device frame rate.
- On packaged Windows/iOS/Android later, confirm light/dark legibility, the
  shared medallion handoff, fast input, focus return, stable Glass distortion,
  modal behavior and sustained frame rhythm. Next coverage: Workspace gallery
  viewer/toolbar shared transitions, mobile dock continuity across routes,
  device details/status transitions, and strong offline/permission/failure cases.
