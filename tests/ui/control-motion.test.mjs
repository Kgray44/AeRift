import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = file => readFileSync(new URL(`../../packages/ui/src/${file}.css`, import.meta.url), "utf8");
const rule = (source, selector) => {
  const start = source.indexOf("\n" + selector + " {");
  assert.notEqual(start, -1, selector);
  return source.slice(start + selector.length, source.indexOf("}", start));
};

test("buttons ease return, compress faster and keep a visible keyboard outline", () => {
  const styles = css("styles");
  assert.match(rule(styles, ".ae-button"),
    /transition:[^;]*transform var\(--ae-motion-press\)[^;]*outline-offset var\(--ae-motion-press\)[^;]*box-shadow var\(--ae-motion-press\)/);
  const press = rule(styles, '.ae-button:not(:disabled, [aria-disabled="true"]):active');
  assert.match(press, /transition-duration:\s*calc\(var\(--ae-motion-press\) \* \.55\)/);
  assert.match(press, /scale\(var\(--ae-press-scale\)\)/);
  assert.match(rule(styles, ".ae-theme :focus-visible"), /outline:\s*2px solid var\(--ae-focus\)/);
  assert.match(rule(styles, ".ae-button:focus-visible"), /outline-offset:\s*3px/);
});

test("device hover and selection interpolate only the border and tactile inset", () => {
  assert.match(rule(css("styles"), ".ae-device-body"),
    /transition:\s*border-color var\(--ae-motion-press\)[^;]*box-shadow var\(--ae-motion-press\)/);
  const tokens = [...css("tokens").matchAll(/--ae-motion-press: ([^;]+);/g)].map(m => m[1]);
  assert.deepEqual(tokens, ["130ms", "0ms", "0ms"]);
});

test("native popovers travel from their trigger side with pointer-inert closing", () => {
  const motion = css("motion");
  assert.match(rule(motion, ".ae-popover"), /--ae-overlay-y:\s*-\.22rem/);
  assert.match(rule(motion, '.ae-popover[data-anchor-side="above"]'), /--ae-overlay-y:\s*\.22rem/);
  assert.match(motion, /\.ae-popover:not\(:popover-open\)\s*\{\s*pointer-events:\s*none/);
  assert.match(motion, /\[data-motion="reduce"\] :is\(\.ae-sheet, \.ae-popover\)\s*\{\s*animation:\s*none;\s*transition:\s*none/);
  assert.match(motion, /prefers-reduced-motion:\s*reduce[^]*\.ae-theme :is\(\.ae-sheet, \.ae-popover\)\s*\{\s*animation:\s*none;\s*transition:\s*none/);
});
