import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopNoteCategory, desktopNoteLibraryKey, loadDesktopNoteLibrary,
  removeDesktopNoteCategory, removeDesktopNoteMetadata, renameDesktopNoteCategory,
  saveDesktopNoteLibrary, setDesktopNoteCategory, sortDesktopNotes, touchDesktopNote,
} from "../../apps/aerift/src/desktop-note-library.ts";

function storage(initial = null) {
  let stored = initial;
  return {
    getItem(key) {
      assert.equal(key, desktopNoteLibraryKey);
      return stored;
    },
    setItem(key, value) {
      assert.equal(key, desktopNoteLibraryKey);
      stored = value;
    },
  };
}

const oldTime = "2026-11-21T12:05:00.000Z";
const newTime = "2026-11-24T12:05:00.000Z";

test("notes metadata round-trips independently of note content", () => {
  const source = storage();
  const empty = loadDesktopNoteLibrary(source);
  let library = createDesktopNoteCategory(empty, "school", "  School  ");
  library = renameDesktopNoteCategory(library, "school", "Courses");
  library = setDesktopNoteCategory(library, "note-1", "school");
  library = touchDesktopNote(library, "note-1", newTime);
  assert.deepEqual(empty, { categories: [], memberships: {}, modifiedAt: {} });
  assert.equal(saveDesktopNoteLibrary(source, library), true);
  assert.deepEqual(loadDesktopNoteLibrary(source), {
    categories: [{ id: "school", name: "Courses" }],
    memberships: { "note-1": "school" },
    modifiedAt: { "note-1": newTime },
  });
  const raw = JSON.parse(source.getItem(desktopNoteLibraryKey));
  assert.deepEqual(Object.keys(raw).sort(), ["categories", "memberships", "modifiedAt", "schemaVersion"].sort());
});

test("removing a category unassigns its notes without changing their recency", () => {
  let library = createDesktopNoteCategory(loadDesktopNoteLibrary(), "club", "Robotics");
  library = setDesktopNoteCategory(library, "note", "club");
  library = touchDesktopNote(library, "note", newTime);
  const ungrouped = removeDesktopNoteCategory(library, "club");
  assert.deepEqual(ungrouped, { categories: [], memberships: {}, modifiedAt: { note: newTime } });
  assert.equal(library.memberships.note, "club");
  assert.deepEqual(removeDesktopNoteMetadata(ungrouped, "note"), {
    categories: [], memberships: {}, modifiedAt: {},
  });
});

test("invalid, duplicate, reserved and over-limit category and note changes are no-ops", () => {
  let library = createDesktopNoteCategory(loadDesktopNoteLibrary(), "club", "Robotics");
  assert.strictEqual(createDesktopNoteCategory(library, "other", "ＲＯＢＯＴＩＣＳ"), library);
  assert.strictEqual(createDesktopNoteCategory(library, "__proto__", "Hidden"), library);
  assert.strictEqual(createDesktopNoteCategory(library, "unusable", "A".repeat(81)), library);
  assert.strictEqual(setDesktopNoteCategory(library, "constructor", "club"), library);
  assert.strictEqual(setDesktopNoteCategory(library, "note", "not-created"), library);
  assert.strictEqual(touchDesktopNote(library, "note", "2026-02-31T00:00:00Z"), library);
  for (let i = 0; i < 30; i++) library = createDesktopNoteCategory(library, `id-${i}`, `Category ${i}`);
  assert.equal(library.categories.length, 24);
});

test("recent notes sort first and ties and unstamped legacy notes keep persisted order", () => {
  const entries = ["legacy-b", "old", "recent-b", "legacy-a", "recent-a"].map(id => ({ id }));
  let library = loadDesktopNoteLibrary();
  library = touchDesktopNote(library, "old", oldTime);
  library = touchDesktopNote(library, "recent-b", newTime);
  library = touchDesktopNote(library, "recent-a", newTime);
  assert.strictEqual(touchDesktopNote(library, "recent-a", oldTime), library);
  assert.deepEqual(sortDesktopNotes(entries, library).map(row => row.id), ["recent-b", "recent-a", "old", "legacy-b", "legacy-a"]);
  assert.deepEqual(entries.map(row => row.id), ["legacy-b", "old", "recent-b", "legacy-a", "recent-a"]);
});

test("corrupt and future snapshots are not read or overwritten; write failures leave old state intact", () => {
  for (const value of ["broken", '{"schemaVersion":2}', '{"schemaVersion":1,"categories":[],"memberships":{"__proto__":"x"},"modifiedAt":{}}']) {
    const source = storage(value);
    const empty = loadDesktopNoteLibrary(source);
    assert.deepEqual(empty, { categories: [], memberships: {}, modifiedAt: {} });
    assert.equal(saveDesktopNoteLibrary(source, createDesktopNoteCategory(empty, "x", "X")), false);
    assert.equal(source.getItem(desktopNoteLibraryKey), value);
  }
  const source = storage();
  const old = loadDesktopNoteLibrary(source);
  const blocked = { getItem: source.getItem, setItem() { throw Error("quota"); } };
  const candidate = createDesktopNoteCategory(old, "x", "X");
  assert.equal(saveDesktopNoteLibrary(blocked, candidate), false);
  assert.deepEqual(loadDesktopNoteLibrary(source), old);
  assert.equal(candidate.categories.length, 1);
});

test("a previously loaded view cannot overwrite a newer persisted category snapshot", () => {
  const source = storage();
  const oldView = loadDesktopNoteLibrary(source);
  const winning = createDesktopNoteCategory(oldView, "a", "A");
  assert.equal(saveDesktopNoteLibrary(source, winning, oldView), true);
  assert.equal(saveDesktopNoteLibrary(source, createDesktopNoteCategory(oldView, "b", "B"), oldView), false);
  assert.deepEqual(loadDesktopNoteLibrary(source), winning);
});

test("category styles persist, are strictly allowlisted, and old category names still load", () => {
  const store = storage();
  const base = createDesktopNoteCategory(loadDesktopNoteLibrary(store), "work", "Work");
  assert.equal(saveDesktopNoteLibrary(store, base), true);
  assert.deepEqual(loadDesktopNoteLibrary(store).categories, [{ id: "work", name: "Work" }]);
  const styled = renameDesktopNoteCategory(base, "work", "Work", { color: "violet", icon: "star" });
  assert.equal(saveDesktopNoteLibrary(store, styled, base), true);
  assert.deepEqual(loadDesktopNoteLibrary(store).categories[0].appearance, { color: "violet", icon: "star" });
  assert.equal(renameDesktopNoteCategory(styled, "work", "Work", { color: "url(example)", icon: "star" }), styled);
  assert.deepEqual(renameDesktopNoteCategory(styled, "work", "Renamed").categories[0].appearance, { color: "violet", icon: "star" });
});
