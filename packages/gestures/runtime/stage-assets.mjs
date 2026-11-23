// Stage pinned, unmodified upstream assets into the host build's local public directory.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [runtime, model, license, destination] = process.argv.slice(2);
if (!runtime || !model || !license || !destination) {
  throw new Error("Usage: node stage-assets.mjs <extracted npm package directory> <model file> <upstream LICENSE> <output directory>");
}

const digests = {
  "vision_bundle.cjs": "43c65a77825c5d5af7456d4781a64cd15cb3e53f479ff1f923c12b5adecf2b44",
  "wasm/vision_wasm_internal.js": "6f6b86509cf9e163ea1cfec7edc8cf53732699c04781e4c21c557c1ba402310e",
  "wasm/vision_wasm_internal.wasm": "cb3ec20026a9aecc2a81a93c25630ceb5389297ddb7a5f0bd61dd09cde606b9b",
  "wasm/vision_wasm_nosimd_internal.js": "9f8fc960e363f0fb2f42f7937b97ae9cf9a5630490f71031fa90caa9bb121938",
  "wasm/vision_wasm_nosimd_internal.wasm": "924274fcd5ac8985f6570a8573e7971b7bd2d580ba1b8f3beb0ba8f95db6347c",
  "hand_landmarker.task": "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
  "LICENSE": "8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8"
};

const assets = await Promise.all(Object.entries(digests).map(async ([name, digest]) => {
  const source = name === "hand_landmarker.task" ? model : name === "LICENSE" ? license : join(runtime, name);
  const bytes = await readFile(source);
  if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error(`Unexpected SHA-256 for ${name}`);
  return [name === "vision_bundle.cjs" ? "vision_bundle.js" : name, bytes];
}));
assets.push(["hand-worker.js", await readFile(fileURLToPath(new URL("./hand-worker.js", import.meta.url)))]);
for (const [name, bytes] of assets) {
  const target = resolve(destination, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
