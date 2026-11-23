# Orbit lab and desktop integration

Orbit is the desktop destination navigator for AeRift. The Simplified and Full destination sets come from `getNavigation` in `@aerift/app-contract/experience`. The host controls the active destination and owns its route contents, persisted preferences, transfer state, and consent.

## Run the lab

From the repository root with workspace dependencies installed:

```sh
npm run test:ui
npx vite --config tests/ui/vite.config.mts --host 127.0.0.1 --port 47781
```

Open `http://127.0.0.1:47781/orbit.html`. The lab has fixture surfaces and keeps the selected file and target in memory across route changes. Switch between Full and Simplified, light and dark, reduced motion, or conventional navigation in the footer. Change the shortcut on the Settings fixture. Turn on **Inspect morph**, select a destination, and scrub **Morph frame**. Resize or select again while a frame is held to exercise interruption.

The lab is also built alongside the GLASS showcase. The browser harness uses Playwright installed in the environment and a running lab:

```sh
node tests/ui/orbit-browser.mjs
```

Set `AERIFT_ORBIT_PLAYWRIGHT` to a Playwright JavaScript entry if it is installed outside the repository, `AERIFT_ORBIT_BROWSER` to an optional Chromium executable such as Edge, and `AERIFT_ORBIT_EVIDENCE` to an output directory for JPEG frames. Override the lab URL with `AERIFT_ORBIT_URL` if needed.

## Desktop host mounting

```tsx
const surface = useRef<HTMLElement>(null);

<Orbit
  destinations={navigation.primary}
  active={route}
  onNavigate={setRoute}
  surfaceRef={surface}
  presentation={navigation.presentation === "conventional" ? "conventional" : "orbit"}
  shortcut={shortcut}
  reducedMotion={preferences.motion === "reduce"}
  status={status}
/>
<OrbitSurface ref={surface} aria-labelledby="destination-heading">
  <h2 id="destination-heading" data-orbit-focus tabIndex={-1}>{label}</h2>
  {surfaceContent}
</OrbitSurface>
```

Keep one stable `OrbitSurface` mounted across destination changes. Commit the controlled route on selection. Orbit takes the clicked orb's displayed bounds, then animates the clipped boundary and GLASS skin of that same live surface from those bounds. It frames the new content at its final layout throughout the reveal. The accessible heading receives focus on commit. The host keeps persistent transfer controllers above visual routing and continues to display consent, errors, and ongoing transfers as appropriate.

- Use `status` only for live destination feedback. The fixture demonstrates paired devices and active transfers.
- `shortcut` accepts `alt-o` (default), `alt-shift-o`, or `off`. The shortcut is inactive while an editable field or modal has focus. The orb is independently keyboard accessible with Enter, Space, and arrow keys.
- The fan falls back to a scrollable conventional list when its measured footprint exceeds the available viewport. Users can also choose the persistent conventional control.
- Orbit uses the shared reduced-motion policy and existing GLASS and easing tokens. The bounded, Orbit-specific fan and morph animations cancel when superseded. Changes to layout during a morph settle into the new target. The component exposes opt-in lens roles for the shared optical renderer.
- Press-and-drag and contextual previews were evaluated for scope. The current interaction uses explicit click or keyboard activation. It keeps targets stable during hover and lets visible labels convey destination intent.

## Browser evidence

Windows Edge, 1240 × 760 unless indicated. The four paused morph frames are from the live destination surface. At 0 ms its skin bounds match the displayed, hovered Devices orb to within 2 CSS px. The harness resumes the real animation to capture settlement.

| State | Capture |
| --- | --- |
| Dark Full desktop at rest | [Resting Home](evidence/orbit/01-dark-rest.jpg) |
| Full fan, Devices hovered | [Expanded](evidence/orbit/02-dark-expanded.jpg) |
| Orbit to Devices, sampled at fixed times | [0 ms](evidence/orbit/03-morph-0.jpg), [80 ms](evidence/orbit/03-morph-80.jpg), [158 ms](evidence/orbit/03-morph-158.jpg), [236 ms](evidence/orbit/03-morph-236.jpg) |
| Completed destination | [Settled Devices](evidence/orbit/04-dark-settled.jpg) |
| Light Simplified mode, 940 × 620 | [Expanded](evidence/orbit/05-light-expanded.jpg) |
| Resized while open, 420 × 220 | [Compact fallback](evidence/orbit/06-compact-fallback.jpg) |
| Light theme with reduced motion | [Direct route settlement](evidence/orbit/07-reduced-motion.jpg) |

The harness checks keyboard focus and direction, dismissal, consecutive route changes, live resize, retained fixture state, conventional navigation, forced colors, and both explicit and OS reduced-motion settings. Mission 3 owns installed Windows shell integration and native transfer qualification. The lab uses fixtures for these checks. Native screen readers and hardware frame pacing remain acceptance checks.
