import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const host = process.argv[2];
if (!host) throw new Error("Usage: stage-camera-assets.mjs TAURI_FRONTEND_ROOT");
const destination = join(host, "src-tauri/src/platform/android/android/src/main/assets");
const cache = join(host, ".android-cache");
const assets = [
  ["hand_landmarker.task",
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1", 16 * 1024 * 1024],
  ["mediapipe-LICENSE", "https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE",
    "8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8", 128 * 1024],
];
await mkdir(destination, { recursive: true });
await mkdir(cache, { recursive: true, mode: 0o700 });
for (const [name, url, expected, max] of assets) {
  const verified = bytes => bytes.length <= max && createHash("sha256").update(bytes).digest("hex") === expected;
  const cached = join(cache, name);
  const staged = join(destination, name);
  let bytes = await readFile(cached).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!bytes || !verified(bytes)) {
    bytes = await readFile(staged).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  if (!bytes || !verified(bytes)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(90_000), redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`Failed to obtain pinned ${name}: HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > max) throw new Error(`Pinned ${name} exceeded its byte cap`);
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks, size);
    if (!verified(bytes)) throw new Error(`Unexpected checksum for ${name}`);
  }
  const temporary = cached + "." + process.pid + ".tmp";
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, cached);
    await copyFile(cached, staged);
  } finally {
    await rm(temporary, { force: true });
  }
}
