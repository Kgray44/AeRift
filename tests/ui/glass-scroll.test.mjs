import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = path => readFileSync(new URL("../../packages/ui/src/" + path, import.meta.url), "utf8");
test("scene and lens layers are viewport anchored, not repositioned by document scroll", () => {
  const css = read("glass.css");
  assert.match(css, /\.ae-glass-atmosphere[^{}]*\{\s*position: fixed;/);
  assert.match(css, /\.ae-glass-fallback\s*\{\s*position: fixed;/);
  const source = read("GlassOptics.tsx");
  assert.doesNotMatch(source, /-bounds\.top|canvas\.style\.top/);
  assert.match(source, /ctx\.putImageData\(output, 0, 0\)/);
});
test("scroll doesn't advance or render the scene; it waits for motion to settle", () => {
  const source = read("GlassOptics.tsx");
  const scroll = source.slice(source.indexOf("const onScroll"), source.indexOf("const geometryEvent"));
  assert.match(scroll, /data-ae-scrolling/);
  assert.match(scroll, /setTimeout/);
  assert.doesNotMatch(scroll, /phase\s*\+=|paintFrame\(/);
  assert.match(source, /if \(scrolling\) return;/);
  assert.match(source, /if \(sceneKey !== paintedSceneKey\)/);
});
