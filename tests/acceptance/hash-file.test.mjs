import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertSameFile } from "./hash-file.mjs";

test("checks empty, binary and multiple read chunks and rejects altered bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aerift-hash-test-"));
  t.after(() => rm(directory, { recursive: true }));
  const source = join(directory, "source.bin");
  const received = join(directory, "received.bin");
  for (const sample of [Buffer.alloc(0), Buffer.of(0, 255, 128, 13, 10), Buffer.alloc(2 ** 20, 255)]) {
    await writeFile(source, sample);
    await writeFile(received, sample);
    assert.deepEqual(await assertSameFile(source, received), {
      sizeBytes: sample.length,
      sha256: createHash("sha256").update(sample).digest("hex"),
    });
  }
  await writeFile(received, Buffer.alloc(2 ** 20, 254));
  await assert.rejects(() => assertSameFile(source, received), /saved bytes differ/);
});
