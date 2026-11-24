// Run from the repo root: node scripts/benchmark-glass-optics.mjs <base-ref>
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { cases, phases, sceneFor } from "../tests/ui/glass-optics-fixtures.mjs";

function load(source) {
  const result = {};
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  });
  new Function("exports", "require", outputText)(result, () => ({}));
  return result;
}
const pathname = "packages/ui/src/GlassOptics.tsx";
const base = process.argv[2];
if (!base) throw new Error("Pass a local baseline Git revision such as e8cab6ef.");
const original = load(execFileSync("git", ["show", base + ":" + pathname], { encoding: "utf8" }));
const current = load(readFileSync(pathname, "utf8"));
for (const [name, width, height, scale, boxes, override] of cases) {
  const source = sceneFor(width, height), frame = source.slice();
  const hash = createHash("sha256");
  function paint(module, time) {
    frame.set(source);
    const recipe = { ...module.aeRiftGlassRecipe, ...override };
    for (const box of boxes) module.shadeLens(frame, source, width, height, box, scale, time, recipe);
  }
  for (const time of phases) {
    paint(original, time);
    const expected = frame.slice();
    paint(current, time);
    if (!Buffer.from(frame).equals(Buffer.from(expected))) throw new Error(name + ": raster parity failure");
    hash.update(frame);
  }
  for (let frameIndex = 0; frameIndex < 12; frameIndex++) {
    paint(original, frameIndex * .037);
    paint(current, frameIndex * .037);
  }
  const arms = [original, current], samples = [[], []];
  // Interleave the arms and alternate ordering to reduce CPU drift bias.
  for (let batch = 0; batch < 9; batch++) {
    for (const arm of batch % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      for (let frameIndex = 0; frameIndex < 6; frameIndex++) paint(arms[arm], frameIndex * .083 + .71 * batch);
      samples[arm].push((performance.now() - start) / 6);
    }
  }
  const [before, after] = samples.map(values => values.sort((a, b) => a - b)[4]);
  console.log(name, hash.digest("hex"), `${before.toFixed(3)} -> ${after.toFixed(3)} ms/frame`,
    `${((before - after) / before * 100).toFixed(1)}%`);
}
