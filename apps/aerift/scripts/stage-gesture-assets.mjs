import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const cache = new URL("../.gesture-cache/", import.meta.url);
  await mkdir(cache, { recursive: true });

  async function cacheAsset(name, source, maxBytes) {
    const file = new URL(name, cache);
    try {
      await readFile(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok || !response.body) throw new Error(`Could not download ${name}: HTTP ${response.status}`);
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error(`${name} exceeds its download size limit`);
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      await writeFile(file, Buffer.concat(chunks, size));
    }
    return fileURLToPath(file);
  }

  const [model, license] = await Promise.all([
    cacheAsset("hand_landmarker.task", "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", 16 * 1024 * 1024),
    cacheAsset("LICENSE", "https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE", 128 * 1024),
  ]);
  const runtime = dirname(fileURLToPath(import.meta.resolve("@mediapipe/tasks-vision")));
  const stage = fileURLToPath(new URL("../../../packages/gestures/runtime/stage-assets.mjs", import.meta.url));
  const destination = fileURLToPath(new URL("../public/gesture-assets/", import.meta.url));
  const result = spawnSync(process.execPath, [stage, runtime, model, license, destination], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Failed to validate and stage the Windows gesture assets.");
}
