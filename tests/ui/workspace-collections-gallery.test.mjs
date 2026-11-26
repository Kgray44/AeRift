import assert from "node:assert/strict";
import test from "node:test";
import { collectionGalleryRows, changeCollectionGallery, decodeCollectionGalleryAppearance, emptyCollectionGalleryAppearance, normalizeCollectionTitle } from "../../apps/aerift/src/workspace-collections-gallery.ts";

const rows = [
  { id: "a", name: "Europe trip", memberIds: ["photo"] },
  { id: "b", name: "Weekend", memberIds: ["note", "text"] },
  { id: "c", name: "Reference", memberIds: [] },
];
const ids = new Set(rows.map(row => row.id));
const style = { color: "mint", icon: "star" };
const fresh = () => emptyCollectionGalleryAppearance();

test("one clean name is enough to make an empty collection", () => {
  assert.equal(normalizeCollectionTitle("  Weekend  "), "Weekend");
  assert.equal(normalizeCollectionTitle(" "), undefined);
  assert.equal(normalizeCollectionTitle("bad\nname"), undefined);
  assert.equal(normalizeCollectionTitle("x".repeat(101)), undefined);
});

test("recents are explicit, bounded, deduplicated, and do not replace All", () => {
  let state = fresh();
  for (const id of ["b","a","b"]) state = changeCollectionGallery(state, { type: "visit", id }, ids);
  assert.deepEqual(collectionGalleryRows(rows, state, "recents", "").map(row => row.id), ["b","a"]);
  assert.deepEqual(collectionGalleryRows(rows, state, "all", "").map(row => row.id), ["a","b","c"]);
  assert.deepEqual(collectionGalleryRows(rows, state, "all", "europe TRIP").map(row => row.id), ["a"]);
  assert.equal(changeCollectionGallery(state, { type: "visit", id: "not-owned" }, ids), null);
  const many = new Set(Array.from({ length: 45 }, (_, i) => `visit-${i}`));
  for (const id of many) state = changeCollectionGallery(state, { type: "visit", id }, many);
  assert.equal(state.recents.length, 32);
});

test("a category groups collection references without editing any collection contents", () => {
  let state = changeCollectionGallery(fresh(), { type: "putCategory", id: "travel", name: " Travel ", style }, ids);
  state = changeCollectionGallery(state, { type: "assign", id: "b", categoryId: "travel" }, ids);
  state = changeCollectionGallery(state, { type: "assign", id: "a", categoryId: "travel" }, ids);
  assert.deepEqual(collectionGalleryRows(rows, state, { categoryId: "travel" }, ""), rows.slice(0, 2));
  assert.equal(changeCollectionGallery(state, { type: "putCategory", id: "duplicate", name: "travel", style }, ids), null);
  state = changeCollectionGallery(state, { type: "removeCategory", id: "travel" }, ids);
  assert.deepEqual(state.assignments, []);
  assert.deepEqual(collectionGalleryRows(rows, state, "all", ""), rows);
  assert.deepEqual(rows[1].memberIds, ["note","text"]);
});

test("invalid sidecar data cannot mount arbitrary styles or orphaned categories", () => {
  const input = { schemaVersion: 1, recents: ["a","unknown","a"], categories: [
    { id: "x", name: "Unsafe", style: { color: "https://bad", icon: "glob" } },
    { id: "good", name: "Clean", style },
  ], assignments: [{ id: "a", categoryId: "good" }, { id: "b", categoryId: "x" }, { id: "unknown", categoryId: "good" }] };
  const state = decodeCollectionGalleryAppearance(input, ids);
  assert.deepEqual(state.recents, ["a"]);
  assert.deepEqual(state.categories.map(category => category.id), ["good"]);
  assert.deepEqual(state.assignments, [{ id: "a", categoryId: "good" }]);
  assert.deepEqual(decodeCollectionGalleryAppearance({ schemaVersion: 2 }, ids), fresh());
});
