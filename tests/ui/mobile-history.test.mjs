import assert from "node:assert/strict";
import test from "node:test";
import { decodeMobileHistory, recordTransfers, withArchivedTransfers } from "../../apps/aerift/src/ios/mobile-history.ts";

const base = { deviceId: "pair", direction: "incoming", file: { name: "log.txt", sizeBytes: 8 } };
const live = { ...base, id: "receiving", state: "transferring", bytesTransferred: 4 };
const done = { ...base, id: "done", state: "completed", bytesTransferred: 8 };
const canceled = { ...base, id: "old", state: "cancelled", bytesTransferred: 3 };

test("Activity remembers only authoritative terminal records", () => {
  const previous = [canceled];
  assert.deepEqual(recordTransfers(previous, [live, done]), [done, canceled]);
  assert.equal(recordTransfers(previous, [live, canceled]), previous);
  assert.deepEqual(decodeMobileHistory(JSON.stringify([live, done, { ...done, id: "bad", bytesTransferred: 0 }])), [done]);
});

test("archive retention is bounded and archived receipts cannot replace live state", () => {
  const previous = Array.from({ length: 70 }, (_, i) => ({ ...done, id: String(i) }));
  const saved = recordTransfers([], previous);
  assert.equal(saved.length, 60);
  assert.deepEqual(withArchivedTransfers([live], [done, { ...canceled, id: live.id }]), [live, done]);
  assert.deepEqual(decodeMobileHistory("corrupted"), []);
  assert.deepEqual(decodeMobileHistory(JSON.stringify([done, done])), [done]);
});
