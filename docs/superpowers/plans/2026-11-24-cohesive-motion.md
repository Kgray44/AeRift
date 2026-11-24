# AeRift cohesive motion pass

Follow the governing experience spec rather than adding a new visual style.
Use the current exact glass recipe and existing truthful transfer states. Begin
from #55; keep changes separate from glass qualification. No protocol, picker,
camera, app-lifecycle or release changes.

- Use one shared vocabulary for touch/press, new content, overlay, navigation,
  progress and signature choreography. Keep Orbit's spatial morph on desktop,
  a short direction-aware reveal on iOS, and the Rift's distinctive passage.
  Avoid sheet-style full-screen movement for routine content or settings.
- Commit real state and focus immediately. A transition may render decorative
  old content briefly, not delay access to new content or leave stale controls
  interactive. Superseded, hidden, resized and reduced-motion cases settle.
- Let native surfaces retain top-layer interaction. Make sheet/anchored
  popover entrances and exits consistent, with an immediate fallback on
  WebViews without discrete transitions. No JavaScript delay to real close.
- Use live matching glass: a shape-local material during movements that would
  otherwise leave stale pixels in the fixed raster, and the exact sampled
  optics on settled shapes. Do not add continuous rendering to the idle shell.
- Verify desktop and iOS fixtures and both reduced-motion paths. Measure real
  animation bounds, state and cleanup where possible; distinguish mocks,
  simulator builds and physical render/performance qualification.
