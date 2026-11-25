import test from "node:test";
import assert from "node:assert/strict";
import { findReceivedRows, groupReceivedTimeline, receivedFileKind, receivedTime } from "../../apps/aerift/src/received-activity.ts";
const rows = [
  { id: "clip", name: "clip.mp4", sizeBytes: 20, source: "Studio Mac" },
  { id: "doc-a", name: "Harbor.pdf", sizeBytes: 30, receivedAt: "2026-11-20T16:30:00Z" },
  { id: "doc-b", name: "Inspection.pdf", sizeBytes: 35, receivedAt: "2026-11-20T10:00:00-07:00", source: "Studio Mac" },
  { id: "odd", name: "Readme.pdf.exe", sizeBytes: 10, receivedAt: "2026-02-30T10:00:00Z" },
];
test("find filters trusted displayed metadata, with no result from unavailable sources", () => {
  assert.deepEqual(findReceivedRows(rows, "mac video").map(x => x.id), ["clip"]);
  assert.deepEqual(findReceivedRows(rows, "studio inspection").map(x => x.id), ["doc-b"]);
  assert.deepEqual(findReceivedRows(rows, "harbor nonexistent"), []);
});
test("timeline sorts explicit timestamps, and undated data is separate, not given invented times", () => {
  const result = groupReceivedTimeline(rows);
  assert.deepEqual(result.dated.map(row => row.id), ["doc-b", "doc-a"]);
  assert.deepEqual(result.undated.map(row => row.id), ["clip", "odd"]);
});
test("calendar checks reject ambiguity and recognize zones", () => {
  assert.equal(receivedTime("2026-02-30T10:00:00Z"), undefined);
  assert.equal(receivedTime("2026-11-20T10:00:00"), undefined);
  assert.equal(receivedTime("2026-11-20"), undefined);
  assert.equal(receivedTime("2026-11-20T10:00:00-07:00"), Date.parse("2026-11-20T17:00:00Z"));
});
test("extension guessing is descriptive only and uses final suffix", () => {
  assert.equal(receivedFileKind("a.JPG"), "Image");
  assert.equal(receivedFileKind("Readme.pdf.exe"), "File");
  assert.equal(receivedFileKind("map"), "File");
});
