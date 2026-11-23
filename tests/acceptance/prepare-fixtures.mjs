import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { hashFile } from "./hash-file.mjs";

const maxLargeBytes = 128 * 1024 * 1024;
const allBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

function* zeroChunks(size) {
  const chunk = Buffer.alloc(64 * 1024);
  for (let remaining = size; remaining > 0; remaining -= chunk.length) {
    yield chunk.subarray(0, Math.min(remaining, chunk.length));
  }
}

export async function prepareFixtures(parent, largeBytes = maxLargeBytes) {
  assert.ok(Number.isSafeInteger(largeBytes) && largeBytes >= 1 && largeBytes <= maxLargeBytes,
    "large fixture size must be an integer from 1 to 134217728 bytes");

  const directory = await mkdtemp(join(resolve(parent), "aerift-fixtures-"));
  await mkdir(join(directory, "duplicate-a"));
  await mkdir(join(directory, "duplicate-b"));

  const fixtures = [
    ["empty", "empty.bin", Buffer.alloc(0)],
    ["binary", "binary.bin", allBytes],
    ["duplicate-a", "duplicate-a/same.bin", Buffer.from("AeRift duplicate A\n")],
    ["duplicate-b", "duplicate-b/same.bin", Buffer.from("AeRift duplicate B\n")],
  ];
  for (const [, path, content] of fixtures) {
    await writeFile(join(directory, path), content, { flag: "wx" });
  }

  // A fixed counter stream supplies reproducible bytes with a bounded working buffer.
  const stream = createCipheriv("aes-256-ctr", Buffer.alloc(32), Buffer.alloc(16));
  await pipeline(Readable.from(zeroChunks(largeBytes)), stream,
    createWriteStream(join(directory, "large.bin"), { flags: "wx" }));

  const files = [];
  for (const [id, path] of [...fixtures, ["large", "large.bin"]]) {
    files.push({ id, path, ...await hashFile(join(directory, path)) });
  }
  const manifest = { files };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" });
  return { directory, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , parent, rawSize] = process.argv;
  assert.ok(parent && process.argv.length <= 4,
    "usage: node prepare-fixtures.mjs <existing output folder> [large-file bytes]");
  assert.ok(rawSize === undefined || /^[1-9][0-9]*$/.test(rawSize), "use a decimal byte count");
  const { directory } = await prepareFixtures(parent, rawSize === undefined ? undefined : Number(rawSize));
  console.log(directory);
}
