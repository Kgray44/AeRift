import test from "node:test";
import assert from "node:assert/strict";
import { emptyGalleryIndex, updateGalleryCategory, browseGalleryRows, recordGalleryImports, readGalleryIndex, writeGalleryIndex } from "../../apps/aerift/src/workspace-gallery-index.ts";
import { documentPreviewAvailable, readDocumentText, documentPreviewBytes } from "../../apps/aerift/src/workspace-document-tools.ts";

test("categories only mutate known references; deletion does not remove documents", () => {
  const rows = [{ id: "lecture", name: "Lecture.pdf" }, { id: "calc", name: "Calculations.csv" }];
  const ids = new Set(rows.map(row => row.id));
  const initial = updateGalleryCategory(emptyGalleryIndex(), { type: "create", id: "school", name: " School ", color: "blue", icon: "star" }, ids);
  const next = updateGalleryCategory(initial, { type: "toggle", categoryId: "school", itemId: "lecture" }, ids);
  assert.deepEqual(browseGalleryRows(next, rows, "school", "lecture"), [rows[0]]);
  assert.equal(updateGalleryCategory(next, { type: "toggle", categoryId: "school", itemId: "external" }, ids), null);
  const removed = updateGalleryCategory(next, { type: "remove", categoryId: "school" }, ids);
  assert.deepEqual(browseGalleryRows(removed, rows, undefined, ""), rows);
  assert.deepEqual(next.categories[0].ids, ["lecture"]);
});

test("newly imported rows order by actual date; unknown dates keep stable catalog order", () => {
  const index = recordGalleryImports(emptyGalleryIndex(), ["b"], 20);
  const rows = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C", importedAt: 10 }];
  assert.deepEqual(browseGalleryRows(index, rows, undefined, "").map(row => row.id), ["b", "c", "a"]);
});

test("document metadata index is scoped and rejects paths or untrusted visual values", () => {
  const data = new Map();
  const local = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  assert.equal(writeGalleryIndex(local, "documents:desktop", recordGalleryImports(emptyGalleryIndex(), ["/native/file"], 2)), true);
  assert.deepEqual(readGalleryIndex(local, "documents:desktop"), emptyGalleryIndex());
  const index = updateGalleryCategory(emptyGalleryIndex(), { type: "create", id: "ok", name: "Literature", icon: "note" }, new Set());
  assert.equal(writeGalleryIndex(local, "documents:desktop", index), true);
  assert.equal(readGalleryIndex(local, "documents:desktop").categories.length, 1);
  assert.deepEqual(readGalleryIndex(local, "documents:ios"), emptyGalleryIndex());
  assert.equal(updateGalleryCategory(index, { type: "edit", categoryId: "ok", name: "Literature", color: "url(evil)" }, new Set()), null);
});

test("only bounded valid text formats are decoded and markup remains literal", async () => {
  const source = "<script>alert(1)</script>\nplain";
  assert.equal(await readDocumentText("example.md", new Blob([source])), source);
  assert.equal(documentPreviewAvailable("a.pdf", 5), false);
  assert.equal(documentPreviewAvailable("a.txt.exe", 5), false);
  assert.equal(await readDocumentText("a.pdf", new Blob([source])), undefined);
  assert.equal(await readDocumentText("a.txt", new Blob([new Uint8Array([0xff])])), undefined);
  assert.equal(await readDocumentText("a.csv", new Blob(["a\u0000b"])), undefined);
  assert.equal(await readDocumentText("a.txt", new Blob([new Uint8Array(documentPreviewBytes + 1)])), undefined);
});
