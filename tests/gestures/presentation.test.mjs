import assert from "node:assert/strict";
import { test } from "node:test";
import { GestureIntent } from "../../dist/gestures/packages/gestures/src/intent.js";
import * as gestures from "../../dist/gestures/packages/gestures/src/index.js";

function present(intent, kind = "send") {
  assert.equal(typeof gestures.presentGesture, "function", "gesture control presents real recognition feedback");
  return gestures.presentGesture(intent.feedback, kind);
}

const send = () => new GestureIntent("gesture", { kind: "send", selectionId: "file", deviceId: "phone" }, () => {});

function observe(intent, posture, times) {
  for (const captureMs of times) {
    intent.observe({ captureMs, posture, track: 1, confidence: null }, captureMs);
  }
}

test("inactive, camera permission, activation, and denial are distinct", () => {
  const intent = send();
  assert.equal(present(intent).state, "inactive");
  intent.setCamera("requesting");
  assert.equal(present(intent).state, "permission");
  intent.setCamera("starting");
  assert.equal(present(intent).state, "activating");
  intent.setCamera("denied");
  assert.equal(present(intent).state, "permission-denied");
});

test("camera unavailability is presented without reporting a detection", () => {
  const intent = send();
  intent.setCamera("unavailable");
  assert.equal(present(intent).state, "unavailable");
  assert.equal(present(intent).phase, "failed");
});

test("the workspace reacts to the first eligible hand before the grasp becomes ready", () => {
  const intent = send();
  intent.setCamera("ready");
  assert.equal(present(intent).phase, "listening");
  observe(intent, "open", [10]);
  assert.equal(present(intent).phase, "hand-detected");
  observe(intent, "open", [80, 150, 220]);
  assert.equal(present(intent).phase, "ready-to-grasp");
  observe(intent, "fist", [290]);
  assert.equal(present(intent).phase, "grasping");
  observe(intent, "fist", [360, 430]);
  assert.equal(present(intent).phase, "held");
  observe(intent, "open", [500, 570, 640]);
  assert.equal(present(intent).phase, "released");
});

test("the same held posture instructs send and incoming consent differently", () => {
  const intent = send();
  intent.setCamera("ready");
  observe(intent, "open", [10, 80, 150, 220]);
  observe(intent, "fist", [290, 360, 430]);
  assert.match(present(intent).message, /send/i);
  assert.match(present(intent, "receive").message, /accept/i);
});

test("manual cancellation and loss of tracking remain distinct through camera teardown", () => {
  const canceled = send();
  canceled.setCamera("ready");
  canceled.cancel();
  canceled.setCamera("disabled");
  assert.equal(present(canceled).phase, "canceled");

  const interrupted = send();
  interrupted.setCamera("ready");
  observe(interrupted, "open", [10, 80, 150, 220]);
  interrupted.cancel("tracking-lost");
  interrupted.setCamera("disabled");
  assert.equal(present(interrupted).phase, "interrupted");
});
