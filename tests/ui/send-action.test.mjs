import assert from "node:assert/strict";
import { test } from "node:test";
import { offerTransfer } from "../../packages/ui/src/send-action.ts";

const target = { id: "peer", name: "iPhone", platform: "ios", paired: true, online: true };
const selection = { selectionId: "file", name: "sample.pdf", sizeBytes: 8 };
const intent = { deviceId: "peer", selectionId: "file" };

test("stale, offline and unpaired intents cannot reach the adapter", async () => {
  for (const [device, file] of [
    [{ ...target, online: false }, selection],
    [{ ...target, paired: false }, selection],
    [target, { ...selection, selectionId: "replacement" }],
    [{ ...target, id: "replacement" }, selection],
  ]) {
    const port = { transfer() { assert.fail("stale intent reached the adapter"); } };
    assert.deepEqual(await offerTransfer(port, device, file, intent), null);
  }
});

test("a valid button or gesture intent uses the same v1 offer", async () => {
  const result = { ok: true, value: { id: "transfer" } };
  const port = { transfer(request) {
    assert.deepEqual(request, { action: "offer", ...intent });
    return Promise.resolve(result);
  } };
  assert.equal(await offerTransfer(port, target, selection, intent), result);
});

test("a dropped replacement invalidates the old gesture before the new file can be offered", async () => {
  const droppedFile = { selectionId: "drop", name: "dropped.bin", sizeBytes: 12 };
  const requests = [];
  const port = { transfer(request) {
    requests.push(request);
    return Promise.resolve({ ok: true, value: { id: "receipt" } });
  } };
  assert.equal(await offerTransfer(port, target, droppedFile, intent), null);
  await offerTransfer(port, target, droppedFile, { ...intent, selectionId: droppedFile.selectionId });
  assert.deepEqual(requests, [{ action: "offer", deviceId: target.id, selectionId: "drop" }]);
});
