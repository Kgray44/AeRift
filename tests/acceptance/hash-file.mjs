import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";

export async function hashFile(path) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

export async function assertSameFile(source, received) {
  const expected = await hashFile(source);
  const actual = await hashFile(received);
  assert.deepEqual(actual, expected, "saved bytes differ from source");
  return actual;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4, "usage: node hash-file.mjs <source> <received>");
  console.log(JSON.stringify(await assertSameFile(process.argv[2], process.argv[3])));
}
