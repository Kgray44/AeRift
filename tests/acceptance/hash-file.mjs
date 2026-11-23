import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
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

export async function assertFixtureFile(manifest, id, received) {
  assert.ok(Array.isArray(manifest.files), "invalid fixture manifest");
  const matches = manifest.files.filter((file) => file.id === id);
  assert.equal(matches.length, 1, "expected exactly one matching fixture ID");
  const { sizeBytes, sha256 } = matches[0];
  assert.ok(Number.isSafeInteger(sizeBytes) && sizeBytes >= 0, "invalid fixture size");
  assert.match(sha256 ?? "", /^[0-9a-f]{64}$/, "invalid fixture SHA-256");
  const actual = await hashFile(received);
  assert.deepEqual(actual, { sizeBytes, sha256 }, "saved bytes differ from fixture manifest");
  return { id, ...actual };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--fixture") {
    assert.equal(args.length, 4, "usage: node hash-file.mjs --fixture <manifest> <id> <received>");
    const manifest = JSON.parse(await readFile(args[1], "utf8"));
    console.log(JSON.stringify(await assertFixtureFile(manifest, args[2], args[3])));
  } else {
    assert.equal(args.length, 2, "usage: node hash-file.mjs <source> <received>");
    console.log(JSON.stringify(await assertSameFile(args[0], args[1])));
  }
}
