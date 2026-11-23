# AeRift GLASS Design Specification

GLASS is AeRift’s first theme for the shared Windows and iOS interface. Indigo and teal ambient tones frame neutral content planes, a mint action color in dark mode, and thin optical highlights. Stable placement and plain status labels keep attention on the file, target and result.

## Research and application

- Apple separates floating controls and navigation from content and reserves clear material for visually rich backgrounds. AeRift uses solid file and device surfaces with translucency concentrated in the toolbar and floating controls. [Apple HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- Apple ties movement to feedback and status and adjusts intensity to input and accessibility preferences. GLASS uses a short press response, floating overlay entrances and a gesture confirmation, with immediate state changes in reduced motion. [Apple HIG Motion](https://developer.apple.com/design/human-interface-guidelines/motion) · [Apple Liquid Glass adoption guidance](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
- Harrison, Kurtenbach and Vicente measured how layer distinctiveness and transparency affect overlapping tool palettes. Sawyer and colleagues found Gaussian blur and scrims improved glanceable text over complex backgrounds in their experiments. AeRift applies these findings by reducing background detail and tinting chrome. Its palettes still require contrast checks on the backgrounds they ship with. [UIST transparency study](https://www.research.autodesk.com/app/uploads/2023/03/an-experimental-evaluation-of.pdf_recnlGNHgFB63p2GI.pdf) · [Sawyer et al., Ergonomics](https://www.bendsawyer.com/wp-content/uploads/2025/05/Sawyer-et-al_2020_Glanceable-legible-typography-over-complex-backgrounds.pdf)
- Microsoft uses Acrylic for depth with solid fallbacks for system and accessibility settings. GLASS targets WCAG 2.2 AA ratios of 4.5:1 for normal text and 3:1 for required control and state indicators. Primary targets use 44 CSS px at default browser scale. [Microsoft Acrylic guidance](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic) · [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- Chrome’s performance guidance favors transform and opacity and identifies blur as costly to paint. GLASS updates progress with a transform and uses fixed, local filters. CSS handles short transitions without a separate animation runtime. [Chrome animation performance guidance](https://web.dev/articles/animations-guide)

## Materials and tokens

| Layer | Role | Treatment |
| --- | --- | --- |
| Field | Ambient app backdrop | Static tonal gradients over the scheme base |
| Content | Devices, files and transfers | Solid fill and thin edge |
| Raised | Workspace panels | Solid fill, top highlight and soft depth shadow |
| Chrome | Toolbar | 81–84% tint, 14 px blur, 1.18 saturation on wider viewports |
| Overlay | Sheet, popover and toast | 94–95% tint, 12 px blur, same saturation and stronger shadow |

`src/tokens.css` defines semantic foreground, fill, edge, focus, feedback and motion roles. The font stack follows the host, with 15 px body, 13 px captions and a fluid display role at default browser scale. Layers share .25–2 rem spacing and .875–1.5 rem control and panel radii. Compact widths use one column, an opaque toolbar, bottom sheets and safe-area padding. Wide layouts use two columns and centered sheets.

Press feedback lasts 130 ms with a 0.98 scale. Overlay entry lasts 200 ms with 8 px travel and an ease-out curve. Progress transitions use 240 ms. Gesture confirmation pairs a short entrance with a visible state label. Fine pointers get a hover highlight. Touch and keyboard have press and focus feedback.

## Accessibility and platform tradeoffs

Increased contrast strengthens text and boundaries and makes chrome opaque. Reduced transparency uses the same opaque materials. Reduced motion removes travel and duration. Windows forced colors use system colors for focus and selection. The host can forward native preferences when the WebView lacks the corresponding media query. A theme owner should verify foreground contrast against the brightest and darkest composites of each new backdrop.

Native Liquid Glass dynamically lenses and refracts underlying pixels, varies light and shape during interaction and participates in system rendering. GLASS uses tint, blur, saturation and static edge highlights in CSS, with its own palette and geometry across the two WebViews. [Apple WWDC25 Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)

Browser verification covers the component layout and simulated flows. Native qualification requires Windows WebView2, physical iPhone WebKit, VoiceOver and Narrator. Profile scrolling and transfer updates with long lists and an open sheet on those hosts to establish native frame pacing and battery cost.
