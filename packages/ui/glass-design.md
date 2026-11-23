# AeRift GLASS design

GLASS is the shared Windows and iOS WebView theme. Its floating toolbar and navigation sit above the working surfaces. The transfer workspace gives file selection a visible optical surface, places paired devices in a grouped list and dedicates a separate lane to progress and history. Compact screens stack the lanes, retain the section shortcuts and present sheets inside the viewport safe area.

## Apple guidance and decisions

- Use the functional layer for navigation, useful actions and temporary overlays. Keep file names, device names and transfer state on denser reading surfaces. A sticky toolbar lets content move beneath a shallow blur. Foreground contrast comes from the tint and fill behind the control. [Apple HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- Align nested shapes. Toolbars, shortcuts and primary actions use capsules. Device groups, file cards and the compact sheet use related corner radii. The glass stage is part of file selection and keeps the action left-aligned over a darker, predictable field. [Apple’s design-system session](https://developer.apple.com/videos/play/wwdc2025/356/)
- Tie motion to the action that caused it. A button compresses and lights from the interaction point. An anchored popover grows from its placement edge. A compact sheet rises and follows a downward drag on its grip. Keyboard users can close a sheet from its Close button or Escape. [Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/) · [Apple HIG Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- Use the reserved overlay layer for consent and appearance settings. Pairing, transfer state and gesture controls use the same local app actions as before. Apple’s SwiftUI glass APIs are available to native SwiftUI hosts. AeRift’s shared WebView uses its own CSS material so Windows and iOS can share the same layout and control logic. [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views)

## Material layers

| Layer | Purpose | Treatment |
| --- | --- | --- |
| Field | Establish context behind the workspace | Static ambient highlights and scheme-aware color |
| Raised | Compose and activity lanes | Denser tint, grazing highlight and depth shadow |
| Content | File rows, device rows and transfer cards | Stable fill or high-opacity tint with distinct text and controls |
| Chrome | Toolbar and section shortcuts | Fixed blur with a top reflection, cool lower rim, saturating tint and depth |
| Overlay | Sheets, menus and toasts | Denser tint and more pronounced edge and shadow over a modal veil |
| Control | Buttons, switches and state feedback | Capsules, optical highlights, visible focus and brief transforms |

The file stage uses two curved reflectors over a local light field to suggest lens thickness. The WebView filter samples the underlying content for chrome and overlays. CSS gradients and inset shadows approximate edge reflections. Native Liquid Glass additionally renders adaptive refraction and morphing at the system compositor level. [Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)

## Accessibility and rendering

Scheme and accessibility behavior remain token driven. System and explicit light and dark schemes set the palette. Compact toolbar blur is 8 CSS px and desktop toolbar blur is 13 px. Overlay blur is 20 px. Denser material fills prevent layering several live filters over every device or transfer card. The entry and press effects animate transform or opacity and progress changes use a transform. Pointer and touch positions update the highlight at press or entry. There is no per-frame pointer loop or continuously running animation. [Chrome animation performance guidance](https://web.dev/articles/animations-guide)

High contrast and reduced transparency make the functional layers opaque and remove the file-stage reflectors. Reduced motion omits the animated changes and sheet tracking. Forced colors preserves native checkboxes. Text, buttons, focus outlines and state labels remain in the normal semantic reading order. Most interactive controls use a 44 CSS px minimum hit area. The 4.5:1 normal-text and 3:1 key control-boundary contrast targets apply when reviewing new backdrops. [WCAG 2.2](https://www.w3.org/TR/WCAG22/) · [Microsoft Acrylic guidance](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic)

Transparency research supports reducing background detail and using a tint behind text. Tested conditions from glanceable text and tool-palette studies inform these choices. Each new theme and backdrop still needs its own contrast and performance pass. [UIST transparency study](https://www.research.autodesk.com/app/uploads/2023/03/an-experimental-evaluation-of.pdf_recnlGNHgFB63p2GI.pdf) · [Sawyer et al., Ergonomics](https://www.bendsawyer.com/wp-content/uploads/2025/05/Sawyer-et-al_2020_Glanceable-legible-typography-over-complex-backgrounds.pdf)

The design uses the same `TransferWorkspace` and semantic tokens in the showcase and host. WebView2, iPhone WebKit, native assistive technology and device performance remain platform qualification checks.

## Clear recipe calibration

This pass follows the owner's November 23 laboratory recipe. The important material changes are minimal face tint, a shallow and sharply defined optical edge, pronounced localized bend, thin colored separation at the edge, and two directional reflection patches. The laboratory JSON is a visual reference, not a promise of a pixel-identical algorithm across engines. In the app, refraction is limited to the shared decorative scene under each sampled workspace surface; DOM copy, focus indicators, text and controls are never refracted or repainted. The sticky toolbar and modal overlays retain WebView sampling so they can respond to genuine UI content behind them.

The app does not embed the experimental laboratory, its fixture files, or its tuning UI. Theme selection and all transfer behaviors are unchanged. High contrast and reduced transparency retain solid materials; reduced motion keeps a stable optical state. The button's existing press flash and the moving active-tab marker preserve contact and navigation feedback. Physical-device optical fidelity and sustained performance must be assessed on the release targets, not inferred from the laboratory.
