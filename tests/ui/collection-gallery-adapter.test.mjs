import assert from "node:assert/strict";
import test from "node:test";
import { availableCollectionMembers, canUpdateCollectionMembers, collectionIncludesClipboard, selectedCollectionMembers } from "../../apps/aerift/src/collection-gallery-adapter.ts";
import { collectionGalleryStorageKey, readCollectionGalleryAppearance, writeCollectionGalleryAppearance } from "../../apps/aerift/src/collection-gallery-storage.ts";

test("carry selected member IDs into creation in order without stale or nested IDs", () => {
  const available = availableCollectionMembers([{ id: "a" }, { id: "b" }, { id: "nested", kind: "collection" }]);
  assert.deepEqual(selectedCollectionMembers(["b", "nested", "missing", "a", "b"], available), ["b", "a"]);
});

test("refuse stale, duplicate, or newly unknown members without rewriting old IDs", () => {
  const available = new Set(["a", "b"]);
  assert.equal(canUpdateCollectionMembers(["a", "legacy"], ["legacy", "b", "a"], ["a", "legacy"], available), true);
  assert.equal(canUpdateCollectionMembers(["a", "legacy"], ["a"], ["legacy", "a"], available), false);
  assert.equal(canUpdateCollectionMembers(["a", "legacy"], ["a", "unknown"], ["a", "legacy"], available), false);
  assert.equal(canUpdateCollectionMembers(["a", "legacy"], ["a", "a"], ["a", "legacy"], available), false);
  assert.equal(collectionIncludesClipboard(["a", "b"], new Set(["b"])), true);
  assert.equal(collectionIncludesClipboard(["a"], new Set(["b"])), false);
});

test("appearance sidecar uses distinct platform keys and handles corrupt or unavailable storage", () => {
  const rows = new Map();
  const store = { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) };
  const keys = ["desktop", "ios", "android"].map(collectionGalleryStorageKey);
  assert.equal(new Set(keys).size, 3);
  const value = { schemaVersion: 1, categories: [], recents: ["legacy"], assignments: [] };
  assert.equal(writeCollectionGalleryAppearance(keys[1], value, store), true);
  assert.deepEqual(readCollectionGalleryAppearance(keys[1], store), value);
  assert.equal(readCollectionGalleryAppearance(keys[2], store), undefined);
  rows.set(keys[1], "{bad");
  assert.equal(readCollectionGalleryAppearance(keys[1], store), undefined);
  assert.equal(writeCollectionGalleryAppearance(keys[2], value, { setItem() { throw new Error("storage denied"); } }), false);
});
