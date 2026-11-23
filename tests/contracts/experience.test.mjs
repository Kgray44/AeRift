import assert from "node:assert/strict";
import { test } from "node:test";
import { createLegacyFileOffer, decodeObject, importLegacySelection, serializeObject } from "../../dist/packages/app-contract/src/digital-objects.js";
import { applyNavigationEvent, createNavigationChange, getNavigation, getVisibleModules, resolveMotion, restorePreferences } from "../../dist/packages/app-contract/src/experience.js";

const fileSelection = { selectionId: "native-handle", name: "photo.heic", sizeBytes: 12 };
const { object: photo, binding } = importLegacySelection("object-1", fileSelection, "photo");

test("native photo stays eligible for v1 using its live picker binding", () => {
  const stored = serializeObject(photo);
  assert.ok(!stored.includes("native-handle"));
  assert.deepEqual(decodeObject(stored), photo);
  assert.deepEqual(createLegacyFileOffer(photo, binding, "windows"), {
    action: "offer", deviceId: "windows", selectionId: "native-handle",
  });
  assert.equal(createLegacyFileOffer(photo, undefined, "windows"), undefined);
  assert.equal(createLegacyFileOffer({ ...photo, id: "other" }, binding, "windows"), undefined);
  assert.equal(createLegacyFileOffer({ ...photo, sizeBytes: 13 }, binding, "windows"), undefined);
});

test("object documents retain supported types and ordered collection references", () => {
  const shared = { schemaVersion: 1, name: "Example", ownership: "local" };
  const objects = [
    { ...shared, id: "1", kind: "file", sizeBytes: 2 },
    { ...shared, id: "2", kind: "video", sizeBytes: 3, mediaType: "video/mp4" },
    { ...shared, id: "3", kind: "text", format: "plain", text: "A" },
    { ...shared, id: "4", kind: "text", format: "markdown", text: "**B**" },
    { ...shared, id: "5", kind: "url", url: "https://example.test/" },
    { ...shared, id: "6", kind: "note", format: "plain", text: "C" },
    { ...shared, id: "7", kind: "clipboard", objectId: "3" },
    { ...shared, id: "8", kind: "collection", itemIds: ["6", "1", "2"] },
    { ...shared, id: "9", kind: "structured", namespace: "example.record", version: 2, value: { count: 4 } },
    { ...shared, id: "10", kind: "file", sizeBytes: 9, ownership: "received",
      provenance: { deviceId: "peer", transferId: "transfer", receivedAt: "2026-11-23T20:00:00Z" } },
  ];
  for (const object of objects) assert.deepEqual(decodeObject(serializeObject(object)), object);
});

test("object persistence rejects incompatible versions, unsafe URLs, and invalid payloads", () => {
  for (const object of [
    { ...photo, schemaVersion: 2 },
    { ...photo, sizeBytes: -1 },
    { ...photo, selectionId: "should-stay-ephemeral" },
    { ...photo, kind: "url", url: "javascript:alert(1)" },
    { ...photo, kind: "collection", itemIds: [photo.id] },
    { ...photo, kind: "collection", itemIds: ["one", "one"] },
    { ...photo, ownership: "received" },
  ]) assert.equal(decodeObject(JSON.stringify(object)), undefined);
  assert.equal(decodeObject("invalid JSON"), undefined);
});

test("window mode, accessibility navigation, and ambient availability are independent", () => {
  const preferences = restorePreferences({ version: 1, windowMode: "full", ambientEnabled: true, hiddenModules: ["notes"] });
  const capabilities = { ambient: "available", camera: "denied" };
  const desktop = getNavigation("desktop", preferences, capabilities);
  assert.equal(desktop.presentation, "orbit");
  assert.ok(desktop.primary.some(({ id }) => id === "workspace"));
  assert.equal(desktop.ambient, true);
  const simplified = getNavigation("desktop", { ...preferences, windowMode: "simplified", desktopNavigation: "conventional" }, capabilities);
  assert.equal(simplified.presentation, "conventional");
  assert.ok(!simplified.primary.some(({ id }) => id === "workspace"));
  assert.equal(simplified.ambient, true);
  const mobile = getNavigation("mobile", { ...preferences, windowMode: "simplified" }, capabilities);
  assert.equal(mobile.presentation, "bottom");
  assert.deepEqual(mobile.primary.map(({ id }) => id), ["home", "workspace", "rift", "devices", "activity"]);
  assert.equal(mobile.settings.id, "settings");
  assert.equal(mobile.ambient, false);
  assert.ok(!getVisibleModules(preferences).some(({ id }) => id === "notes"));
});

test("navigation falls back to Home when a mode change removes the active destination", () => {
  const nav = getNavigation("desktop", restorePreferences(null), { ambient: "unsupported", camera: "unknown" });
  assert.deepEqual(createNavigationChange(nav, "workspace", "workspace", "mode-change"), {
    from: "workspace", to: "home", cause: "mode-change", focus: "destination-heading",
  });
  assert.equal(createNavigationChange(nav, "home", "home", "user"), undefined);
  assert.equal(createNavigationChange(nav, "activity", "workspace", "user"), undefined);
  assert.equal(resolveMotion("spatial", true), "direct");
});

test("a cancelled or superseded Orbit animation cannot commit after a newer request", () => {
  const nav = getNavigation("desktop", restorePreferences(null), { ambient: "unknown", camera: "unknown" });
  const first = { ...createNavigationChange(nav, "home", "rift", "user"), transitionId: "1" };
  const second = { ...createNavigationChange(nav, "home", "activity", "user"), transitionId: "2" };
  const initial = { current: "home" };
  const pending = applyNavigationEvent(initial, { ...first, phase: "requested" });
  const latest = applyNavigationEvent(pending, { ...second, phase: "requested" });
  assert.equal(applyNavigationEvent(latest, { ...first, phase: "committed" }), latest);
  assert.deepEqual(applyNavigationEvent(latest, { ...second, phase: "committed" }), { current: "activity" });
  const cancelled = applyNavigationEvent(latest, { ...second, phase: "cancelled" });
  assert.deepEqual(cancelled, initial);
  assert.equal(applyNavigationEvent(cancelled, { ...second, phase: "committed" }), cancelled);
});

test("notes retain ordered attachment object IDs and older notes still decode", () => {
  const note = { schemaVersion: 1, id: "note", name: "Trip", kind: "note",
    ownership: "local", format: "plain", text: "Packing list" };
  const attached = { ...note, attachmentIds: ["photo", "chart"] };
  assert.deepEqual(decodeObject(serializeObject(attached)), attached);
  assert.deepEqual(decodeObject(serializeObject(note)), note);
  for (const candidate of [
    { ...attached, kind: "text" },
    { ...note, attachmentIds: ["photo", "photo"] },
    { ...note, attachmentIds: ["note"] },
    { ...note, attachmentIds: [""] },
    { ...note, attachmentIds: "chart" },
  ]) assert.equal(decodeObject(JSON.stringify(candidate)), undefined);
});
