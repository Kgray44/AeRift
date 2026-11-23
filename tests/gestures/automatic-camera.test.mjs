import assert from "node:assert/strict";
import test from "node:test";
import * as gestures from "../../dist/gestures/packages/gestures/src/index.js";

const own = { selectionId: "selected-file", deviceId: "recipient" };
const offer = { transferId: "offered-file", deviceId: "sender" };
const second = { transferId: "another-file", deviceId: "sender" };

test("a newly arrived offer cannot switch an existing sender gesture", () => {
  assert.equal(typeof gestures.automaticGestureTarget, "function");
  assert.deepEqual(gestures.automaticGestureTarget(own, [offer], ""), { kind: "send", ...own });
});

test("an unambiguous incoming offer can listen without enabling consent", () => {
  assert.deepEqual(gestures.automaticGestureTarget(null, [offer], ""), { kind: "receive", ...offer });
  assert.equal(gestures.automaticGestureTarget(null, [offer, second], ""), null);
});

test("a chosen offer can never fall through to an unrelated transfer", () => {
  assert.deepEqual(gestures.automaticGestureTarget(own, [offer, second], second.transferId), { kind: "receive", ...second });
  assert.equal(gestures.automaticGestureTarget(own, [offer], second.transferId), null);
});

test("an expired listening attempt rearms only after capture was granted", () => {
  assert.equal(typeof gestures.cameraRecovery, "function");
  const feedback = { camera: "disabled", interruption: "attempt-timeout" };
  assert.equal(gestures.cameraRecovery(feedback, true), "rearm");
  assert.equal(gestures.cameraRecovery(feedback, false), "retry-from-settings");
});

test("denial and camera contention require intentional retry", () => {
  for (const camera of ["denied", "busy", "unavailable", "error"]) {
    assert.equal(gestures.cameraRecovery({ camera, interruption: null }, true), "retry-from-settings");
  }
});

test("background suspension waits for a fresh foreground event", () => {
  assert.equal(gestures.cameraRecovery({ camera: "suspended", interruption: null }, true), "wait-for-foreground");
  assert.equal(gestures.cameraRecovery({ camera: "suspended", interruption: "tracking-lost" }, true), "rearm");
});

test("a pre-ready target change can recheck an existing grant without another permission request", () => {
  const feedback = { camera: "starting", interruption: "target-changed" };
  assert.equal(gestures.cameraRecovery(feedback, false, true), "rearm");
  assert.equal(gestures.cameraRecovery(feedback, false, false), "retry-from-settings");
});
