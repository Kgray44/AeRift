import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertFixtureFile, assertSameFile } from "./hash-file.mjs";
import { prepareFixtures } from "./prepare-fixtures.mjs";

test("checks empty, binary and multiple read chunks and rejects altered bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aerift-hash-test-"));

  const source = join(directory, "source.bin");
  const received = join(directory, "received.bin");
  t.after(async () => {
    await rm(source, { force: true });
    await rm(received, { force: true });
    await rmdir(directory);
  });
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

test("identifies renamed exports by fixture ID and rejects the other same-name file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aerift-export-test-"));
  const fixtures = await prepareFixtures(directory, 257);
  const duplicateA = join(fixtures.directory, "duplicate-a", "same.bin");
  const renamedExport = join(fixtures.directory, "duplicate-b", "same (1).bin");
  const duplicateB = join(fixtures.directory, "duplicate-b", "same.bin");
  t.after(async () => {
    for (const { path } of fixtures.manifest.files) {
      await rm(join(fixtures.directory, path), { force: true });
    }
    await rm(renamedExport, { force: true });
    await rm(join(fixtures.directory, "manifest.json"), { force: true });
    await rmdir(join(fixtures.directory, "duplicate-a"));
    await rmdir(join(fixtures.directory, "duplicate-b"));
    await rmdir(fixtures.directory);
    await rmdir(directory);
  });
  await rename(duplicateB, renamedExport);
  const { sizeBytes, sha256 } = fixtures.manifest.files.find((file) => file.id === "duplicate-b");
  assert.deepEqual(await assertFixtureFile(fixtures.manifest, "duplicate-b", renamedExport),
    { id: "duplicate-b", sizeBytes, sha256 });
  await assert.rejects(() => assertFixtureFile(fixtures.manifest, "duplicate-b", duplicateA),
    /differ from fixture manifest/);
  await assert.rejects(() => assertFixtureFile(fixtures.manifest, "missing", renamedExport),
    /exactly one matching fixture ID/);
});
