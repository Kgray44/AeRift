import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function loadOpticsModule(filename, imports = {}) {
  const source = readFileSync(new URL(`../../packages/ui/src/${filename}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  runInNewContext(outputText, { exports, require: name => imports[name] ?? {} });
  return exports;
}
const atmosphere = loadOpticsModule("atmosphere.ts");
const exports = loadOpticsModule("GlassOptics.tsx", { "./atmosphere": atmosphere });
const { aeRiftGlassRecipe: recipe, glassAppearanceRecipes, opticalViewportScale, shadeLens } = exports;

test("atmosphere focus follows reported bytes along the selected route", () => {
  assert.equal(atmosphere.atmosphereTarget("transferring", 0, .79).x, .47);
  assert.equal(atmosphere.atmosphereTarget("transferring", .5, .79).x, .63);
  assert.equal(atmosphere.atmosphereTarget("transferring", 1, .79).x, .79);
});

test("an interrupted atmospheric transition preserves intermediate illumination", () => {
  const held = atmosphere.atmosphereTarget("held");
  const ready = atmosphere.atmosphereTarget("ready");
  const blended = atmosphere.blendAtmosphere(held, ready, .08);
  assert(blended.bend > held.bend && blended.bend < ready.bend);
  const idle = atmosphere.atmosphereTarget();
  assert(atmosphere.blendAtmosphere(blended, idle, .08).energy < blended.energy);
});

test("Light and Dark retain distinct optical softness, exposure and reflection calibration", () => {
  assert.notEqual(glassAppearanceRecipes.light.softness, glassAppearanceRecipes.dark.softness);
  assert.notEqual(glassAppearanceRecipes.light.exposure, glassAppearanceRecipes.dark.exposure);
  assert.notDeepEqual(glassAppearanceRecipes.light.reflectionColor, glassAppearanceRecipes.dark.reflectionColor);
  assert.equal(glassAppearanceRecipes.dark.softness, recipe.softness);
});
test("records the owner's approved calibration rather than the lab defaults", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(recipe)), {
    opacity: 2, warmth: 0, softness: 2, exposure: 108, depth: 9, radius: 26, roundness: 69,
    distortion: 40, dispersion: 100, magnify: 80, shadow: 61, reflection: 76, gloss: 100,
    patches: 60, patchSize: 58, iridescence: 30, edging: 77, edge: 44, light: 315, sweep: 53,
    drift: 48, speed: 116, scroll: 44, scene: "ribbons", surface: "all", showLens: true,
  });
});
test("limits visible work for compact and high-density desktop viewports", () => {
  for (const [w, h, dpr] of [[390, 844, 3], [3840, 2160, 2], [1280, 720, 1]]) {
    const s = opticalViewportScale(w, h, dpr);
    assert(s > 0 && s <= dpr);
    assert(w * s <= 800.001 && w * h * s * s <= 390000.001);
  }
});
test("panel lens leaves the center and outside unchanged while its rim moves", () => {
  const w = 120, h = 100, scene = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < scene.length; p += 4) {
    scene[p] = ((p / 4) % w) * 2;
    scene[p + 1] = Math.floor(p / 4 / w) * 2;
    scene[p + 2] = (p / 4) % 131;
    scene[p + 3] = 255;
  }
  const shape = { x: 12, y: 13, width: 92, height: 66, radius: 21, kind: "panel" };
  const first = scene.slice(), later = scene.slice();
  shadeLens(first, scene, w, h, shape, 1, 0);
  shadeLens(later, scene, w, h, shape, 1, 1);
  const pixel = (buffer, x, y) => buffer.slice((y * w + x) * 4, (y * w + x + 1) * 4);
  assert.deepEqual(pixel(first, 58, 45), pixel(scene, 58, 45));
  assert.deepEqual(pixel(first, 8, 10), pixel(scene, 8, 10));
  assert.notDeepEqual(first, scene);
  assert.notDeepEqual(first, later);
});
