import assert from "node:assert/strict";
import test from "node:test";
import { decodeMobileObjects, normalWebUrl, portableCollection, portableText, removeMobileObject } from "../../apps/aerift/src/ios/local-objects.ts";

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
  const copy = portableCollection(collection, [note, link, collection]);
  assert.equal(copy.name, "AeRift - Trip.txt");
  assert.deepEqual(JSON.parse(copy.text), { schemaVersion: 1, collection, items: [link, note] });
  assert.equal(portableCollection(collection, [note]), undefined);
  assert.equal(portableCollection({ ...collection, itemIds: ["large"] }, [
    { ...note, id: "large", text: "x".repeat(128 * 1024) },
  ]), undefined);
});
