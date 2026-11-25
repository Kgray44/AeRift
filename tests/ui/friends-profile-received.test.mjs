import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transpile } from "typescript";
const source = readFileSync(new URL("../../apps/aerift/src/friends-profile-received.ts", import.meta.url), "utf8");
const model = await import("data:text/javascript;base64," + Buffer.from(transpile(source, { module: 99, target: 9 })).toString("base64"));
const { recentProfileImages, MAX_RECENT_AVATAR_BYTES } = model;
const id = "receipt_aaaaaaaaaaaa";
const grant = "grant_bbbbbbbbbbbbbbbb";
const row = { id, grant, label: "Suggested photo", sizeBytes: 4 };
const blob = () => new Blob([Uint8Array.of(1,2,3,4)]);

test("only the explicitly selected, listed local grant can be read once", async () => {
  const opens = [];
  const catalog = recentProfileImages({
    async listVerified(query) { assert.equal(query.maxCount, 24); return [row]; },
    async openVerified(selection) { opens.push(selection); return blob(); },
  });
  assert.deepEqual(await catalog.list(), [{ id, label: "Suggested photo" }]);
  assert.deepEqual(opens, []);
  await assert.rejects(catalog.open("receipt_zzzzzzzzzzzz"));
  assert.deepEqual(opens, []);
  assert.equal((await catalog.open(id)).size, 4);
  assert.equal(opens[0].grant, grant);
  assert.equal(opens[0].maxBytes, 4);
  await assert.rejects(catalog.open(id));
  assert.equal(opens.length, 1);
});

test("stale, duplicate, malformed, and oversized candidates do not authorize reads", async () => {
  let time = 0;
  let opens = 0;
  const catalog = recentProfileImages({
    async listVerified() { return [row, { ...row, label: "Duplicate" }, { ...row, id: "receipt_cccccccccccc", sizeBytes: MAX_RECENT_AVATAR_BYTES + 1 },
      { ...row, id: "../profile-photo.png" }, { ...row, id: "receipt_dddddddddddd", grant: "file:///tmp/photo" }]; },
    async openVerified() { ++opens; return blob(); },
  }, { clock: () => time });
  assert.deepEqual(await catalog.list(), [{ id, label: "Suggested photo" }]);
  time = 30_001;
  await assert.rejects(catalog.open(id));
  assert.equal(opens, 0);
});

test("the provider cannot substitute different length or bypass request budgets", async () => {
  const catalog = recentProfileImages({
    async listVerified() { return [row]; },
    async openVerified() { return new Blob([Uint8Array.of(1,2,3,4,5)]); },
  });
  await catalog.list();
  await assert.rejects(catalog.open(id), /no longer matches/);
  let signal;
  const stuck = recentProfileImages({
    async listVerified(query) { signal = query.signal; return new Promise(() => {}); },
    async openVerified() { throw Error("not selected"); },
  }, { timeoutMs: 10 });
  await assert.rejects(stuck.list(), /timed out/);
  assert.equal(signal.aborted, true);
});
