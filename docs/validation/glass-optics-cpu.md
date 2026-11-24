# Glass optics CPU measurement

Baseline: `e8cab6efff8e4f100ff582b2ef7d945de3fcd64e`. Run from the repository root with dependencies installed:

```sh
node scripts/benchmark-glass-optics.mjs e8cab6ef
```

Node v24.22.3, disposable cloud Linux. Timings are medians of nine interleaved batches, six frames per batch, after 12 warm-up frames per implementation. The timer includes copying the synthetic scene and running all visible lenses, but excludes React, CSS layout, Canvas 2D readback and upload, and platform compositor. These are representative pixel shapes, not traces captured from an application screen.

| Synthetic raster | Before | After | CPU time change |
| --- | ---: | ---: | ---: |
| Workspace, five overlapping/nonoverlapping lenses | 22.998 ms | 20.041 ms | -12.9% |
| Mobile, four lenses and clipped surfaces | 14.489 ms | 13.260 ms | -8.5% |
| Ambient wide stage, 144 x 104 | 3.204 ms | 3.206 ms | +0.1% (noise) |
| Alternate warm recipe, three mixed lenses | 1.188 ms | 1.164 ms | -2.0% |

All four synthetic rasters matched the baseline byte for byte at each of four phases. The UI test pins aggregate hashes for repeatable non-timing parity. The flat-interior path starts only beyond the directional rim and recipe-dependent highlight cutoff. It retains magnification, softness, tint, and warmth. Regular edges and orbs continue through the full equations. The frame scheduler, DOM geometry, moving local fallback, sizing, and context-loss fallback are not changed; browser lifecycle behavior is not newly verified by this CPU benchmark.

## GPU follow-up, not enabled

The browser path repaints the source atmosphere, reads it back, shades lenses, then uploads the composite. A WebGL2 prototype should avoid per-frame CPU readback, not just accelerate `shadeLens` while retaining an equivalent copy round trip. It would need to render the atmosphere on the GPU or use a canvas-to-texture source and measure its actual copy cost. Composite lenses against the same source in DOM paint order; rounded coverage, directional reflection, color space, and signed/clamped writes need a deliberate differential test, not assumed parity.

Before selecting a backend, measure p50/p95 frame time and sustained CPU/GPU load in the real Windows, iOS and Android WebViews, including compact/hi-DPI layout, overlaps, both themes, resize, moving surfaces, reduced transparency/motion, context loss, and remount. Keep Canvas 2D when WebGL2 is missing or fails; do not alter the production backend until GPU and physical WebView results exist. Chromium is installed in the disposable workspace but its launch stops at a sandbox socket error; GPU availability and runtime savings were not verified here.
