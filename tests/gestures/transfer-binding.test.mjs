import assert from "node:assert/strict";
import { test } from "node:test";
import * as bindings from "../../dist/gestures/packages/gestures/src/send-binding.js";

const incoming = { transferId: "incoming-file", deviceId: "paired-phone" };
const target = { kind: "receive", ...incoming };
const other = { transferId: "other-file", deviceId: incoming.deviceId };

function setup(options = {}) {
  const accepted = [];
  const acceptedChoices = [];
  const outcomes = [];
  const controls = {
    busy: false,
    intent: null,
    incoming: options.incoming ?? [incoming, other],
    async send() {
      assert.fail("An incoming confirmation must never send");
    },
    async accept(offer, chosenOffer) {
      accepted.push(offer);
      acceptedChoices.push(chosenOffer);
      return true;
    },
  };
  assert.equal(typeof bindings.bindTransferGesture, "function", "the shared binding supports a specific incoming offer");
  const binding = bindings.bindTransferGesture("receive-1", target, () => controls, outcome => outcomes.push(outcome),
    options.readChosenOffer);
  binding.intent.setCamera("ready");
  return { binding, controls, accepted, acceptedChoices, outcomes };
}

function observe(binding, posture, times) {
  for (const captureMs of times) {
    binding.intent.observe({ captureMs, posture, track: 1, confidence: null }, captureMs);
  }
}

function grasp(binding) {
  observe(binding, "open", [10, 80, 150, 220]);
  observe(binding, "fist", [290, 360, 430]);
}

function release(binding) {
  observe(binding, "open", [500, 570, 640]);
}

test("incoming consent waits for the full gesture and accepts only the explicitly selected offer once", async () => {
  const { binding, accepted, outcomes } = setup();
  grasp(binding);
  assert.equal(binding.intent.feedback.phase, "held");
  assert.deepEqual(accepted, []);
  release(binding);
  release(binding);
  await Promise.resolve();
  assert.deepEqual(accepted, [incoming]);
  assert.deepEqual(outcomes, ["accepted"]);
});

test("a withdrawn offer cannot accept a different offer from the same device", () => {
  const { binding, controls, accepted, outcomes } = setup();
  grasp(binding);
  controls.incoming = [controls.incoming[1]];
  assert.equal(binding.currentTarget(), null);
  release(binding);
  assert.deepEqual(accepted, []);
  assert.deepEqual(outcomes, ["unavailable"]);
});

test("revalidates the peer identity on a matching incoming transfer ID", () => {
  const { binding, controls, accepted } = setup();
  grasp(binding);
  controls.incoming = [{ ...incoming, deviceId: "different-phone" }];
  binding.intent.updateContext(binding.currentTarget());
  assert.equal(binding.intent.feedback.interruption, "target-changed");
  release(binding);
  assert.deepEqual(accepted, []);
});

test("tracking interruption cannot authorize an offer", () => {
  const { binding, accepted } = setup();
  grasp(binding);
  const feedback = binding.intent.observe({ captureMs: 500, posture: "unusable", track: null, confidence: null }, 500);
  assert.equal(feedback.interruption, "tracking-lost");
  release(binding);
  assert.deepEqual(accepted, []);
});

for (const phase of ["listening", "held"]) {
  test(`an implicit ${phase} attempt loses its target when another offer arrives`, () => {
    const { binding, controls, accepted } = setup({ incoming: [incoming], readChosenOffer: () => "" });
    if (phase === "held") grasp(binding);
    controls.incoming = [incoming, other];
    binding.intent.updateContext(binding.currentTarget());
    assert.equal(binding.intent.feedback.interruption, "target-changed");
    release(binding);
    assert.deepEqual(accepted, []);
  });
}

test("the release boundary rejects newly ambiguous implicit consent before the camera sees a context update", () => {
  const { binding, controls, accepted, outcomes } = setup({ incoming: [incoming], readChosenOffer: () => "" });
  grasp(binding);
  controls.incoming = [incoming, other];
  release(binding);
  assert.deepEqual(accepted, []);
  assert.deepEqual(outcomes, ["unavailable"]);
});

test("a newly available sender takes priority over an implicitly selected incoming target", () => {
  const { binding, controls, accepted } = setup({ incoming: [incoming], readChosenOffer: () => "" });
  grasp(binding);
  controls.intent = { deviceId: "recipient", selectionId: "file" };
  assert.equal(binding.currentTarget(), null);
  release(binding);
  assert.deepEqual(accepted, []);
});

test("an explicitly selected offer stays held as other offers arrive", async () => {
  const { binding, controls, accepted, acceptedChoices } = setup({
    incoming: [incoming], readChosenOffer: () => incoming.transferId,
  });
  grasp(binding);
  controls.incoming = [incoming, other];
  binding.intent.updateContext(binding.currentTarget());
  assert.equal(binding.intent.feedback.phase, "held");
  release(binding);
  await Promise.resolve();
  assert.deepEqual(accepted, [incoming]);
  assert.deepEqual(acceptedChoices, [incoming.transferId]);
});
