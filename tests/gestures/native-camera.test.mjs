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
  const feedback = [];
  const adapter = new NativeGestureCamera(port, "native", intent,
    (state) => feedback.push({ state, subscribed }));
  testContext.after(() => adapter.stop());
  return {
    adapter, intent, commands, stopped, feedback,
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

test("native camera stops at the absolute deadline even while frames continue without a hand", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const s = fixture(t);
  await s.adapter.start();
  s.state("ready");
  for (let at = 100; at < 30_000; at += 100) {
    t.mock.timers.tick(100);
    s.frame(performance.now() + 10_000);
  }
  assert.equal(s.intent.feedback.phase, "acquiring");
  assert.equal(s.subscribed, true);
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(s.subscribed, false);
  assert.equal(s.intent.feedback.phase, "interrupted");
  const terminal = s.feedback.find(({ state }) => state.phase === "interrupted");
  assert.equal(terminal.state.interruption, "attempt-timeout");
  assert.equal(terminal.subscribed, true);
  assert.deepEqual(s.stopped, ["native"]);
  assert.deepEqual(s.commands, ["interrupt"]);
});

test("the native watchdog publishes lost frame feedback before teardown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const s = fixture(t);
  await s.adapter.start();
  s.state("ready");
  for (const captureMs of [10, 80, 150, 220]) {
    s.intent.observe({ captureMs, track: 1, posture: "open", confidence: null }, captureMs + 5);
  }
  assert.equal(s.intent.feedback.phase, "ready");
  now = 450;
  t.mock.timers.tick(50);
  await Promise.resolve();
  assert.equal(s.subscribed, false);
  const terminal = s.feedback.find(({ state }) => state.phase === "interrupted");
  assert.equal(terminal.state.interruption, "frame-gap");
  assert.equal(terminal.subscribed, true);
  assert.deepEqual(s.commands, ["interrupt"]);
});
