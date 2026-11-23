import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashFile } from "./hash-file.mjs";
import { prepareFixtures } from "./prepare-fixtures.mjs";

test("creates independent fixture folders with stable hashes and unequal duplicate contents", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "aerift-fixture-test-"));
  const runs = [];
  t.after(async () => {
    for (const { directory, manifest } of runs) {
      for (const { path } of manifest.files) await unlink(join(directory, path));
      await unlink(join(directory, "manifest.json"));
      await rmdir(join(directory, "duplicate-a"));
      await rmdir(join(directory, "duplicate-b"));
      await rmdir(directory);
    }
    await rmdir(parent);
  });

  const largeBytes = 2 ** 20 + 17;
  const first = await prepareFixtures(parent, largeBytes);
  runs.push(first);
  const second = await prepareFixtures(parent, largeBytes);
  runs.push(second);

  assert.notEqual(first.directory, second.directory);
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(JSON.parse(await readFile(join(first.directory, "manifest.json"), "utf8")),
    first.manifest);
  const [empty, binary, a, b, large] = first.manifest.files;
  assert.equal(empty.sizeBytes, 0);
  assert.equal(empty.sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(binary.sizeBytes, 256);
  assert.equal(a.path.split("/").at(-1), b.path.split("/").at(-1));
  assert.notEqual(a.sha256, b.sha256);
  assert.equal(large.sizeBytes, largeBytes);
  assert.deepEqual(await hashFile(join(first.directory, large.path)),
    { sizeBytes: large.sizeBytes, sha256: large.sha256 });
});

test("rejects invalid sizes before creating fixture directories", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "aerift-fixture-budget-test-"));
  t.after(() => rmdir(parent));
  for (const size of [0, -1, 1.5, Infinity, 128 * 1024 * 1024 + 1]) {
    await assert.rejects(prepareFixtures(parent, size), /large fixture size/);
  }
  assert.deepEqual(await readdir(parent), []);
});
