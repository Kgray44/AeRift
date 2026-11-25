import test from "node:test";
import assert from "node:assert/strict";
import {
  browseWorkspaceFiles, clearWorkspaceFileSearches, rememberWorkspaceFileSearch, readWorkspaceFileSearches,
} from "../../apps/aerift/src/workspace-file-tools.ts";

const rows = [
  { assetId: "first", name: "Photo 10.PNG", sizeBytes: 120, mediaType: "image/png", updatedAt: "2026-11-01T00:00:00Z" },
  { assetId: "second", name: "Photo 2.jpg", sizeBytes: 80, kind: "photo", updatedAt: "2026-11-02T00:00:00Z" },
  { assetId: "third", name: "Café Notes.pdf", sizeBytes: 500, kind: "document" },
  { assetId: "fourth", name: "archive.zip", kind: "file" },
];
const defaults = { query: "", kind: "all", sort: "library" };
const browse = options => browseWorkspaceFiles(rows, row => row, { ...defaults, ...options });

test("browsing searches names and types case-insensitively with AND terms", () => {
  assert.deepEqual(browse({ query: "  café PDF  " }), [rows[2]]);
  assert.deepEqual(browse({ kind: "photo", query: "photo" }), rows.slice(0, 2));
  assert.deepEqual(browse({ kind: "photo", query: "archive" }), []);
  assert.deepEqual(browse({ kind: "other" }), [rows[3]]);
  assert.strictEqual(browse({ query: "png" })[0], rows[0]);
});

test("sort preserves the source and leaves unknown sizes and dates last", () => {
  assert.deepEqual(browse({ kind: "photo", sort: "name" }), [rows[1], rows[0]]);
  assert.deepEqual(browse({ sort: "largest" }), [rows[2], rows[0], rows[1], rows[3]]);
  assert.deepEqual(browse({ sort: "smallest" }), [rows[1], rows[0], rows[2], rows[3]]);
  assert.deepEqual(browse({ sort: "newest" }), [rows[1], rows[0], rows[2], rows[3]]);
  assert.deepEqual(browse({}), rows);
});

test("history keeps explicitly remembered searches bounded, deduplicated, scoped, and clearable", () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  assert.deepEqual(readWorkspaceFileSearches(storage, "desktop:files"), []);
  rememberWorkspaceFileSearch(storage, "desktop:files", "  July  notes ");
  rememberWorkspaceFileSearch(storage, "desktop:files", "july notes");
  assert.deepEqual(readWorkspaceFileSearches(storage, "desktop:files"), ["july notes"]);
  assert.deepEqual(readWorkspaceFileSearches(storage, "android:files"), []);
  for (let i = 0; i < 20; i++) rememberWorkspaceFileSearch(storage, "desktop:files", `query ${i}`);
  const saved = readWorkspaceFileSearches(storage, "desktop:files");
  assert.equal(saved[0], "query 19");
  assert.equal(saved.length, 8);
  clearWorkspaceFileSearches(storage, "desktop:files");
  assert.deepEqual(readWorkspaceFileSearches(storage, "desktop:files"), []);
});

test("invalid and failing storage never make the catalog unusable", () => {
  const malformed = { getItem: () => "{malformed", setItem() { throw new Error("quota"); }, removeItem() { throw new Error("denied"); } };
  assert.deepEqual(readWorkspaceFileSearches(malformed, "files"), []);
  assert.deepEqual(rememberWorkspaceFileSearch(malformed, "files", "recent"), ["recent"]);
  assert.doesNotThrow(() => clearWorkspaceFileSearches(malformed, "files"));
});
