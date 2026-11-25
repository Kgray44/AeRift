import assert from "node:assert/strict";
import { test } from "node:test";
import { offerTransfer, ordinaryWorkspaceDevices } from "../../packages/ui/src/send-action.ts";

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

test("ordinary manual and gesture offers exclude known Friends without suppressing unrelated devices", async () => {
  const friendDevice = { ...target, id: "known-friend-device" };
  const friendRoster = { version: 1, contacts: [{ id: "verified-friend", devices: [{ id: friendDevice.id }] }] };
  const raw = { devices: [target, friendDevice] };
  assert.deepEqual(ordinaryWorkspaceDevices(raw), [target, friendDevice], "no roster must not hide ordinary recipients");
  assert.deepEqual(ordinaryWorkspaceDevices(raw, friendRoster), [target], "separate desktop roster excludes Friends");
  assert.deepEqual(ordinaryWorkspaceDevices({ ...raw, friends: friendRoster }), [target], "embedded mobile roster excludes Friends");
  assert.deepEqual(ordinaryWorkspaceDevices(raw, { ...friendRoster, version: 2 }), [target, friendDevice]);
  const devices = ordinaryWorkspaceDevices(raw, friendRoster);
  const requests = [];
  const port = { async transfer(request) { requests.push(request); return { ok: true, value: { id: "receipt" } }; } };
  const staleFriend = { ...intent, deviceId: friendDevice.id };
  assert.equal(await offerTransfer(port, devices.find(item => item.id === staleFriend.deviceId), selection, staleFriend), null);
  await offerTransfer(port, devices.find(item => item.id === intent.deviceId), selection, intent);
  assert.deepEqual(requests, [{ action: "offer", ...intent }]);
});
