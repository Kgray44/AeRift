import assert from "node:assert/strict";
import { test } from "node:test";
import { GestureIntent } from "../../dist/gestures/packages/gestures/src/intent.js";
import { NativeGestureCamera } from "../../dist/gestures/packages/gestures/src/native-camera.js";

function fixture(testContext, start = async () => {}) {
  const commands = [];
  const stopped = [];
  let subscribed = false;
  let listener;
  const port = {
    async subscribe(callback) {
      subscribed = true;
      listener = callback;
      return () => { subscribed = false; };
    },
    async clockMs() { return performance.now() + 10_000; },
    start,
    async stop(id) { stopped.push(id); },
  };
  const intent = new GestureIntent("native", { kind: "receive", transferId: "offer" },
    ({ action }) => commands.push(action));
  const adapter = new NativeGestureCamera(port, "native", intent, () => {});
  testContext.after(() => adapter.stop());
  return {
    adapter, intent, commands, stopped,
    get subscribed() { return subscribed; },
    state(state, attemptId = "native") { listener({ type: "state", state, attemptId }); },
    frame(captureMs) { listener({
      type: "frame", attemptId: "native",
      frame: { captureMs, width: 480, height: 640, hands: [] },
    }); },
  };
}

test("native state and frames are scoped to one attempt", async (t) => {
  const s = fixture(t);
  await s.adapter.start();
  s.state("ready", "retired-attempt");
  assert.equal(s.intent.feedback.camera, "requesting");
  s.state("starting");
  s.state("ready");
  s.frame(performance.now() + 10_000);
  assert.equal(s.intent.feedback.camera, "ready");
  assert.equal(s.intent.feedback.posture, "unusable");
  s.state("suspended");
  assert.equal(s.subscribed, false);
  s.state("ready");
  await Promise.resolve();
  assert.equal(s.intent.feedback.camera, "suspended");
  assert.deepEqual(s.stopped, ["native"]);
  assert.deepEqual(s.commands, ["interrupt"]);
});

test("cancellation during native startup ignores late events and requests stop after acknowledgement", async (t) => {
  let acknowledge;
  let requested;
  const started = new Promise((resolve) => { requested = resolve; });
  const s = fixture(t, () => new Promise((resolve) => {
    acknowledge = resolve;
    requested();
  }));
  const pending = s.adapter.start();
  await started;
  s.adapter.stop();
  s.state("ready");
  acknowledge();
  await pending;
  assert.equal(s.subscribed, false);
  assert.deepEqual(s.stopped, ["native", "native"]);
  assert.deepEqual(s.commands, ["interrupt"]);
});
