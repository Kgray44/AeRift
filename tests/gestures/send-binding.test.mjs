import assert from "node:assert/strict";
import { test } from "node:test";
import { bindSendGesture } from "../../dist/gestures/packages/gestures/src/send-binding.js";

const original = { deviceId: "windows", selectionId: "file" };

function setup() {
  const sends = [];
  const outcomes = [];
  const controls = {
    intent: original,
    busy: false,
    async send(intent) {
      sends.push(intent);
      return true;
    },
  };
  const binding = bindSendGesture("gesture-1", () => controls, (outcome) => outcomes.push(outcome));
  binding.intent.setCamera("ready");
  return { binding, controls, sends, outcomes };
}

function observe(binding, posture, times) {
  for (const captureMs of times) {
    binding.intent.observe({ captureMs, posture, track: 1, confidence: null }, captureMs);
  }
}
function arm(binding) {
  observe(binding, "open", [10, 80, 150, 220]);
  observe(binding, "fist", [290, 360, 430]);
}
function release(binding) {
  observe(binding, "open", [500, 570, 640]);
}

test("calls the workspace Send function once with the exact captured intent", async () => {
  const { binding, sends, outcomes } = setup();
  arm(binding);
  release(binding);
  release(binding);
  await Promise.resolve();
  assert.deepEqual(sends, [original]);
  assert.deepEqual(outcomes, ["sent"]);
});

for (const [reason, mutate] of [
  ["changed peer", (controls) => { controls.intent = { ...original, deviceId: "other" }; }],
  ["changed file", (controls) => { controls.intent = { ...original, selectionId: "new-file" }; }],
  ["lost target", (controls) => { controls.intent = null; }],
  ["manual send already pending", (controls) => { controls.busy = true; }],
]) {
  test(`revalidates the live workspace when there is a ${reason}`, () => {
    const { binding, controls, sends, outcomes } = setup();
    arm(binding);
    mutate(controls);
    release(binding);
    assert.deepEqual(sends, []);
    assert.deepEqual(outcomes, ["unavailable"]);
  });
}

test("failed dispatch gets an outcome and queued release frames cannot retry it", async () => {
  const { binding, controls, outcomes } = setup();
  let calls = 0;
  controls.send = async () => { calls++; throw new Error("connection closed"); };
  arm(binding);
  release(binding);
  release(binding);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(outcomes, ["failed"]);
});

test("requires an available selected file and peer before camera startup", () => {
  assert.equal(bindSendGesture("gesture-1", () => ({ intent: null, busy: false, send: async () => true }), () => {}), null);
  assert.equal(bindSendGesture("gesture-1", () => ({ intent: original, busy: true, send: async () => true }), () => {}), null);
});
