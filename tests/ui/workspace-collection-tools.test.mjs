import assert from "node:assert/strict";
import test from "node:test";
import { collectionCandidates, changeCollectionMembership } from "../../apps/aerift/src/workspace-collection-tools.ts";

const items = [
  { id: "a/file", name: "Harbor Chart", kind: "file" },
  { id: "b", name: "Weather", kind: "note" },
  { id: "c", name: "Harbor site", kind: "url" },
  { id: "d", name: "Harbor folder", kind: "collection" },
  { id: "c", name: "duplicate", kind: "file" },
];

test("finds only ungrouped, non-collection candidates without changing opaque IDs", () => {
  assert.deepEqual(collectionCandidates(items, ["c"], "harbor FILE").map(x => x.id), ["a/file"]);
  assert.deepEqual(collectionCandidates(items, [], "harbor").map(x => x.id), ["a/file", "c"]);
  assert.deepEqual(collectionCandidates(items, [], "").map(x => x.id), ["a/file", "b", "c"]);
});

test("add and remove change references only, preserving unrelated and unavailable items", () => {
  const before = Object.freeze(["c", "missing"]);
  assert.deepEqual(changeCollectionMembership(before, { type: "add", id: "a/file" }, items), ["c", "missing", "a/file"]);
  assert.deepEqual(changeCollectionMembership(before, { type: "remove", id: "missing" }, items), ["c"]);
  assert.deepEqual(before, ["c", "missing"]);
});

test("invalid, duplicate, or nested additions and out-of-bounds moves are no-ops", () => {
  const before = ["a/file", "c", "missing"];
  for (const id of ["unknown", "a/file", "d"]) {
    assert.equal(changeCollectionMembership(before, { type: "add", id }, items), null);
  }
  assert.equal(changeCollectionMembership(before, { type: "move", id: "a/file", by: -1 }, items), null);
  assert.equal(changeCollectionMembership(before, { type: "remove", id: "unknown" }, items), null);
  assert.deepEqual(changeCollectionMembership(before, { type: "move", id: "missing", by: -1 }, items), ["a/file", "missing", "c"]);
});
