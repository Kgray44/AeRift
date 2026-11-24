import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const ui = name => readFileSync(new URL(`../../packages/ui/src/${name}`, import.meta.url), "utf8");
const css = name => ui(name + ".css");
const orbit = () => ui("orbit-surface.tsx");

test("full and reduced motion have a single clock for CSS routes, Orbit and overlays", () => {
  const tokens = css("tokens");
  for (const name of ["route", "overlay", "orbit-open", "orbit-morph", "expressive"]) {
    const matches = [...tokens.matchAll(new RegExp(`--ae-motion-${name}: ([^;]+);`, "g"))];
    assert(matches.length >= 3, name);
    assert(matches[0][1] !== "0ms" && matches.slice(1).every(m => m[1] === "0ms"), name);
  }
  assert.match(orbit(), /--ae-motion-orbit-morph/);
  assert.match(css("orbit"), /var\(--ae-motion-orbit-open\)/);
  assert.match(css("motion"), /data-ae-route-enter/);
  assert.match(css("motion"), /@starting-style/);
  assert.doesNotMatch(css("glass"), /--ae-press-scale:\s*\./, "a later glass rule must not undo reduced press scaling");
});

test("app and system reduction disable camera pulse, spinner and progress decoration", () => {
  const cssText = css("motion");
  for (const pattern of [/\[data-motion="reduce"\]/, /prefers-reduced-motion/, /ae-camera-light/, /ae-spinner/]) {
    assert.match(cssText, pattern);
  }
});

test("duration parsing works with browser CSS units, a true zero, and invalid computed styles", () => {
  const source = orbit().match(/(?:export )?function motionMilliseconds\([^]*?\n\}/)?.[0];
  assert(source, "Orbit must use a testable CSS time parser");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const exports = {};
  const parse = runInNewContext(outputText + "\n motionMilliseconds;", { exports });
  assert.equal(parse(" 0ms ", 460), 0);
  assert.equal(parse(".46s", 400), 460);
  assert.equal(parse("425ms", 400), 425);
  assert.equal(parse("ease", 400), 400);
  assert.equal(parse("-2ms", 400), 400);
});

test("keyboard and assistive Orbit selections keep the destination heading visible instead of clipping it", () => {
  const component = ui("Orbit.tsx");
  assert.match(component, /select\(id, event\.currentTarget, event\.detail > 0\)/);
  assert.match(component, /const orb = radial && spatialPointer \?/);
});
