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

test("Light and Dark pass the same exact material through to the live renderer", () => {
  for (const key of ["opacity", "warmth", "softness", "exposure", "depth", "radius", "roundness", "distortion", "dispersion",
    "magnify", "shadow", "reflection", "gloss", "patches", "patchSize", "iridescence", "edging", "edge", "light", "sweep", "drift", "speed"]) {
    assert.equal(glassAppearanceRecipes.light[key], recipe[key], key);
    assert.equal(glassAppearanceRecipes.dark[key], recipe[key], key);
  }
});
test("records the owner's approved calibration rather than the lab defaults", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(recipe)), {
    opacity: 11, warmth: 0, softness: 5, exposure: 100, depth: 10, radius: 26, roundness: 81,
    distortion: 40, dispersion: 61, magnify: 73, shadow: 83, reflection: 51, gloss: 100,
    patches: 56, patchSize: 100, iridescence: 47, edging: 71, edge: 26, light: 315, sweep: 70,
    drift: 72, speed: 76, scroll: 44, scene: "ribbons", surface: "all", showLens: true,
  });
});
test("limits visible work for compact and high-density desktop viewports", () => {
  for (const [w, h, dpr] of [[390, 844, 3], [3840, 2160, 2], [1280, 720, 1]]) {
    const s = opticalViewportScale(w, h, dpr);
    assert(s > 0 && s <= dpr);
    assert(w * s <= 800.001 && w * h * s * s <= 390000.001);
  }
});
test("panel lens transmits the background through the exact tint, leaves outside unchanged and moves its rim", () => {
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
  assert.notDeepEqual(pixel(first, 58, 45), pixel(scene, 58, 45));
  assert.deepEqual(pixel(first, 8, 10), pixel(scene, 8, 10));
  assert.notDeepEqual(first, scene);
  assert.notDeepEqual(first, later);
});

test("quiet destinations ignore transfer energy but visible Rift states can strengthen the field", () => {
  for (const isLight of [true, false]) {
    const quiet = atmosphere.atmosphereIntensity(false, 0, isLight);
    const active = atmosphere.atmosphereIntensity(true, .46, isLight);
    assert.equal(atmosphere.atmosphereIntensity(false, .55, isLight), quiet);
    assert(quiet < atmosphere.atmosphereIntensity(true, 0, isLight));
    assert(active > quiet && active < 1.1);
  }
});

test("small controls transmit their center yet retain a directional rim on an even field", () => {
  const w = 96, h = 64, scene = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < scene.length; p += 4) scene.set([35, 50, 70, 255], p);
  const result = scene.slice();
  shadeLens(result, scene, w, h, { x: 17, y: 15, width: 62, height: 34, radius: 17, kind: "control" }, 1, 0);
  const byte = (x, y) => result[(y * w + x) * 4];
  assert.equal(byte(48, 33), 59, "11% Lab white mix in a regular control center");
  assert(byte(48, 15) > byte(48, 48));
});

test("the production regular card and control both use the requested center tint and exceed the old 4px softness cap", () => {
  const w = 128, h = 90, scene = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < scene.length; i += 4) scene.set([35, 50, 70, 255], i);
  const pixel = (image, x, y) => Array.from(image.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
  for (const kind of ["panel", "control"]) {
    const box = { x: 24, y: 18, width: 80, height: 54, radius: 22, kind };
    const flat = scene.slice();
    shadeLens(flat, scene, w, h, box, 1, .7);
    assert.deepEqual(pixel(flat, 64, 45), [59, 72, 90, 255], kind);
    const detail = scene.slice();
    detail[(44 * w + 59) * 4] = 230;
    const now = detail.slice(), capped = detail.slice();
    shadeLens(now, detail, w, h, box, 1, .7);
    shadeLens(capped, detail, w, h, box, 1, .7, { ...glassAppearanceRecipes.dark, softness: 4 });
    assert.notDeepEqual(pixel(now, 64, 45), pixel(capped, 64, 45), kind);
  }
});
