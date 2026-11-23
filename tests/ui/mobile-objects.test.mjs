import assert from "node:assert/strict";
import test from "node:test";
import { addBrowserLinks, decodeMobileObjects, normalWebUrl, noteAttachmentStorageKey, objectStorageKey, persistMobileObjects,
  portableCollection, portableText, readMobileObjects, removeMobileObject } from "../../apps/aerift/src/ios/local-objects.ts";

const base = { schemaVersion: 1, ownership: "local" };
const note = { ...base, id: "note", kind: "note", name: "A résumé", format: "markdown", text: "## Harbor" };
const link = { ...base, id: "link", kind: "url", name: "Map", url: "https://example.com/" };
const collection = { ...base, id: "collection", kind: "collection", name: "Trip", itemIds: [link.id, note.id] };

test("workspace storage recovers heterogeneous collections in order", () => {
  assert.deepEqual(decodeMobileObjects(JSON.stringify([note, link, collection])), [note, link, collection]);
  assert.equal(decodeMobileObjects(JSON.stringify([note, collection])), undefined);
  assert.equal(decodeMobileObjects(JSON.stringify([note, note])), undefined);
  assert.equal(decodeMobileObjects(JSON.stringify([{ ...note, selectionId: "stale" }])), undefined);
});

test("removing an object prunes its collection memberships", () => {
  assert.deepEqual(removeMobileObject([note, link, collection], link.id),
    [note, { ...collection, itemIds: [note.id] }]);
});

test("links remain web-only and transfer as inert text", () => {
  assert.equal(normalWebUrl(" example.com/path "), "https://example.com/path");
  assert.equal(normalWebUrl("https://user:pass@example.com"), undefined);
  assert.equal(normalWebUrl("javascript:alert(1)"), undefined);
  assert.equal(normalWebUrl("file:///etc/hosts"), undefined);
  assert.deepEqual(portableText(note), { name: "AeRift - A resume.md", text: note.text });
  assert.deepEqual(portableText(link), { name: "AeRift - Map.txt", text: link.url });
});

test("a collection copy contains its members in order and fits the existing text transfer", () => {
  const copy = portableCollection(collection, [{ ...note, attachmentIds: ["local-chart"] }, link, collection]);
  assert.equal(copy.name, "AeRift - Trip.txt");
  assert.deepEqual(JSON.parse(copy.text), { schemaVersion: 1, collection, items: [link, note] });
  assert.equal(portableCollection(collection, [note]), undefined);
  assert.equal(portableCollection({ ...collection, itemIds: ["large"] }, [
    { ...note, id: "large", text: "x".repeat(128 * 1024) },
  ]), undefined);
});

test("a previous build can edit note text while attachment references stay readable", () => {
  const entries = new Map([[objectStorageKey, JSON.stringify([note])]]);
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
  const attached = { ...note, attachmentIds: ["chart", "video"] };
  persistMobileObjects(storage, [note], [attached]);
  assert.deepEqual(JSON.parse(storage.getItem(objectStorageKey)), [note]);

  const edited = { ...note, text: "Edited on the earlier build" };
  storage.setItem(objectStorageKey, JSON.stringify([edited]));
  assert.deepEqual(readMobileObjects(storage), [{ ...edited, attachmentIds: attached.attachmentIds }]);

  storage.setItem(objectStorageKey, "[]");
  assert.deepEqual(readMobileObjects(storage), []);
});

test("a failed note write restores its previous attachment references", () => {
  const entries = new Map([[objectStorageKey, JSON.stringify([note])]]);
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
  const attached = { ...note, attachmentIds: ["chart"] };
  persistMobileObjects(storage, [note], [attached]);
  const before = storage.getItem(noteAttachmentStorageKey);
  assert.throws(() => persistMobileObjects({
    ...storage,
    setItem(key, value) {
      if (key === objectStorageKey) throw new Error("disk full");
      storage.setItem(key, value);
    },
  }, [attached], [{ ...note, attachmentIds: ["photo"] }]), /disk full/);
  assert.equal(storage.getItem(noteAttachmentStorageKey), before);
  assert.deepEqual(readMobileObjects(storage), [attached]);
  storage.setItem(noteAttachmentStorageKey, "invalid index");
  assert.deepEqual(readMobileObjects(storage), [note]);
});

test("explicit browser captures are normalized, deduplicated, and remain inert links", () => {
  const result = addBrowserLinks([note, link], [
    { url: "https://example.com", title: "Same link" },
    { url: "javascript:alert(1)", title: "Script" },
    { url: "https://user:secret@example.com/", title: "Credentials" },
    { url: "https://example.test/saved", title: "  Harbor   Guide  " },
    { url: "https://example.test/saved", title: "Duplicate" },
    { url: "https://example.test/station" },
  ], (() => { let next = 1; return () => `capture-${next++}`; })());
  assert.deepEqual(result, [
    { ...base, kind: "url", id: "capture-1", name: "Harbor Guide", url: "https://example.test/saved" },
    { ...base, kind: "url", id: "capture-2", name: "example.test", url: "https://example.test/station" },
    note, link,
  ]);
});
