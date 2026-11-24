# Cross-platform visual refinement

Baseline: `47d9a06076faa625b5d2bb6d8cf390612413e4d7` (latest main at audit). This is a presentation-only follow-up. Open topic PRs #36, #42, #43, and #44 overlap in glass, mobile, Orbit, and desktop files respectively. The changes below start from landed main and do not import those PR branches or change transfer semantics.

## What the baseline showed

| Surface | Observed problem | Change |
| --- | --- | --- |
| Desktop Home | Large utility panel visually outweighed the Rift entry and recent items. | A single typographic Rift entry, compact nearby-device surface, and quieter supporting objects/activity. |
| Desktop Orbit | The radiating layout was distinct, but overlay labels competed with the destination below. Existing orb lens markers were not enrolled in the production sampler. | Visible radial orbs use the sampled lens. Expanded Orbit gets its own focus plane over a gentle blurred veil; existing geometry, keyboard, compact fallback, and destination morph remain. |
| Desktop Workspace / Settings | Empty collections emphasized exposed controls more than objects; settings labels and switches used inconsistent grouping. | Contextual native disclosures retain drafts; a stable object-first split and labeled controls keep the workspace usable at narrow widths. Settings use coherent grouped sections and respect common form controls. |
| iPhone Home / dock | Bright ribbon crossed small text; the dock competed with scroll content, and Workspace broke across lines at 320 CSS px. | A tighter Home introduction, calmer field, lifted reading margin, larger one-line dock labels, and a solid-enough native backdrop underneath the sampled dock for real scrolling content. |
| iPhone Workspace | The six modules used loose text controls and forms dominated the page before there were objects. | A compact aligned module grid with one selected material. Editors use labeled disclosures; existing pickers, previews, attachments, and local save paths remain. |
| Devices, pairing, overlays | Device identity, trust, availability and action occupied the same unstructured row; overlay sheen was unrelated to other chrome. | Distinct platform glyph, identity/trust, real state and action; two localized reflections on the native backdrop of overlays. No new pairing or inferred presence state. |
| Activity | Ribbon highlights crossed progress labels; several inner blocks had the same visual weight. | Integrated rows separate direction, file, status and progress, with lighter and denser reading zones where warranted. No fabricated timestamps. |
| Rift | Existing equipment placement and choreography were the strongest visual reference. | Preserve spatial layout and all state semantics. Only the visible Rift can spend extra atmospheric energy; dock and chosen actions receive bounded edge treatment. |

## Material and runtime verification

- There remains one production optical sampler. Both light and dark variants start from the approved Lab recipe; app control surfaces keep the approved clear center/shallow rim and restrained dispersion. Lab-only scene and scroll controls are not production settings.
- The renderer samples the app-owned artwork, not the DOM. A small symmetric soft sample affects only artwork; labels remain real, sharp DOM. Raster refinement adds directional rounded corner reflections instead of a full colored ring or uniform bevel.
- The expanded dock uses native WebView backdrop over the sampled decorative field to separate labels from actual scroll content, which is not available to an optical canvas. Modal dialogs and popovers continue to use native backdrop and their existing focus handling.
- Optics enroll visible, explicit action roles and Orbit orbs; informational rows and most forms do not become nested lenses. The render loop does not run continuously at idle. Existing viewport caps and reduced-motion, reduced-transparency, increased-contrast and forced-color fallbacks remain.
- The design pass intentionally does not change discovery, transport, cryptography, gesture intent, native camera, device naming, placement, or pairing architecture.

## Reproduce the visual evidence

`npm ci` then `npx vite --config tests/ui/vite.config.mts`; use `/desktop-visual.html?scheme=dark&route=home`, `/mobile.html`, and the existing `/orbit.html` / `/lab.html`. The desktop URL also accepts light/dark, `route=home|rift|workspace|devices|activity|settings`, and `state=populated|empty|offline`. The fixture mounts the actual Windows `DesktopApp` and mocks the existing Tauri IPC boundary. The mobile fixture mounts the actual `IosApp` with deterministic in-memory ports and mock file metadata. Both are development fixtures only, not alternate product UI.

Visual evidence: cloud Chromium at 1363×936 for the desktop, and same-origin framed browser viewports at 390×760 and 320×640 for handheld layout. These are matched, synthetic-data comparisons, not physical devices, an iOS simulator, signed TestFlight evidence, or native WebView2 performance measurements. Release qualification still needs both physical platforms, native accessibility and optical/safe-area checks, and sustained awake/foreground performance checks.

## Owner recipe correction

AeRift now renders from the full November 24 `aerift-glass-lab/v1` setting
set in `GlassOptics.tsx`. Both appearances pass the same material numbers
into the raster, including 11 opacity, 5 softness, 40 distortion, 61
dispersion, 73 magnification, 51 reflection, and 100 patch size. The
previous pass stored a recipe but reduced warp per role, capped softness at
4, and used a separate Light preset. The renderer now uses the Lab's
card, control, and bubble equations for blur, magnification, rounded edge
refraction, chromatic separation, moving specular patches, directional
edging, and iridescence. Sampled regular cards and action buttons no
longer cover the rendered surface with their fallback fill and rim.

The app still reflects its own ribbon artwork, not a Lab screenshot, with
live DOM labels above the optical pass. `drift`, `scroll`, `scene`,
`surface`, and `showLens` are retained with the exact preset for the Lab
but are diagnostic/demo-scene controls, not instructions to move or hide app
content. The app's actual motion and scoped lens visibility remain intact.
Dialogs, popovers, and sticky mobile chrome that cross real DOM content
retain native backdrop effects, as do unsampled/unsuitable CSS surfaces;
reduced-transparency, increased-contrast, and forced-color modes use fallback.
The browser captures are not a hardware WebView performance qualification.
