import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = file => readFileSync(new URL(`../../packages/ui/src/${file}`, import.meta.url), "utf8");

test("shared native overlays keep platform modal and dismissal semantics", () => {
  const markup = ui("overlays.tsx");
  assert.match(markup, /node\.showModal\(\)/);
  assert.match(markup, /if \(!open && node\?\.open\) node\.close\(\)/);
  assert.match(markup, /<OverlayAccents active=\{open\} kind="sheet"\s*\/>/);
  assert.match(markup, /popover="auto"[^]*onToggle=\{event => setShown\(event\.currentTarget\.matches\(":popover-open"\)\)\}/);
  assert.match(markup, /<OverlayAccents active=\{shown\} kind="popover"\s*\/>/);
  assert.match(markup, /hidePopover\(\); trigger.current\?\.focus\(\); action\.onSelect\(\);/);
  assert.doesNotMatch(markup, /onAnimationComplete|AnimatePresence/);
});

test("only hidden, pointer-inert trim uses animation and both motion preferences suppress it", () => {
  const source = ui("OverlayAccents.tsx");
  assert.match(source, /MotionFeedbackProvider/);
  assert.match(source, /useAppearanceMotion\(\) === "reduce"/);
  assert.match(source, /const osReduced = useReducedMotion\(\)/);
  assert.match(source, /if \(!active \|\| appReduced \|\| osReduced\) return null/);
  assert.match(source, /<span className="ae-overlay-accents" data-overlay-kind=\{kind\} aria-hidden="true">/);
  assert.match(source, /opacity: \[0, \.85, \.46, 0\]/);
  const css = ui("overlay-motion.css");
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\[data-motion="reduce"\]/);
  assert.match(css, /forced-colors: active/);
  assert.doesNotMatch(css, /backdrop-filter|filter:|mix-blend-mode/);
});
