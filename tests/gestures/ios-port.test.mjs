import assert from "node:assert/strict";
import { test } from "node:test";
import { createIosCameraPort } from "../../dist/gestures/packages/gestures/src/ios-port.js";
import { bindSendGesture } from "../../dist/gestures/packages/gestures/src/send-binding.js";
import { NativeGestureCamera } from "../../dist/gestures/packages/gestures/src/native-camera.js";

function fixture(clock) {
  const attempts = [];
  const stops = [];
  const channels = [];
  const port = createIosCameraPort({
    clockMs: async () => clock() + 10_000,
    createChannel: (onmessage) => ({ onmessage }),
    async registerEvents(events) { channels.push(events); },
    async start({ attemptId }) { attempts.push(attemptId); },
    async stop({ attemptId }) { stops.push(attemptId); },
  });
  return { port, attempts, channels, stops };
}

function pose(closed) {
  const point = (x, y) => ({ x, y, z: 0, confidence: 0.92 });
  return [
    point(0.5, 0.66), point(0.44, 0.57), point(0.39, 0.52), point(0.37, 0.47), point(0.24, 0.33),
    ...[0.4, 0.46, 0.53, 0.6].flatMap((x) => [
      point(x, 0.5), point(x, 0.43), point(x, 0.38), point(x, closed ? 0.49 : 0.33),
    ]),
  ];
}

test("iOS plugin event shape reaches the same send action exactly once", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const { port, channels, stops } = fixture(() => now);
  const target = { deviceId: "windows-peer", selectionId: "ios-file" };
  const calls = [];
  const outcomes = [];
  const binding = bindSendGesture("ios-1", () => ({
    intent: target, busy: false, async send(intent) { calls.push(intent); return true; },
  }), (outcome) => outcomes.push(outcome));
  const camera = new NativeGestureCamera(port, "ios-1", binding.intent, () => {});
  t.after(() => camera.stop());
  await camera.start();
  const [events] = channels;
  const send = (event) => events.onmessage({ attemptId: "ios-1", ...event });
  send({ type: "state", state: "ready" });
  function samples(times, closed) {
    for (const at of times) {
      now = at + 12;
      send({ type: "frame", frame: { captureMs: at + 10_000, width: 480, height: 640, hands: [pose(closed)] } });
    }
  }
  samples([10, 80, 150, 220], false);
  samples([290, 360, 430], true);
  samples([500, 570, 640], false);
  samples([710, 780, 850], true);
  samples([920, 990, 1060], false);
  await Promise.resolve();
  assert.deepEqual(calls, [target]);
  assert.deepEqual(outcomes, ["sent"]);
  assert.deepEqual(stops, ["ios-1"]);
});

test("replacement attempt reuses the channel and ignores retired attempt events", async () => {
  const { port, attempts, channels } = fixture(() => 0);
  const first = [];
  const second = [];
  const detach = await port.subscribe((event) => first.push(event.state));
  await port.start("old");
  channels[0].onmessage({ type: "state", attemptId: "old", state: "ready" });
  detach();
  await port.subscribe((event) => second.push(event.state));
  await port.start("new");
  channels[0].onmessage({ type: "state", attemptId: "old", state: "denied" });
  channels[0].onmessage({ type: "state", attemptId: "new", state: "ready" });
  assert.deepEqual(attempts, ["old", "new"]);
  assert.equal(channels.length, 1);
  assert.deepEqual(first, ["ready"]);
  assert.deepEqual(second, ["ready"]);
});

test("cancelled registration cannot start its camera when the acknowledgement arrives", async () => {
  let acknowledge;
  const registration = new Promise((resolve) => { acknowledge = resolve; });
  const starts = [];
  const stops = [];
  const port = createIosCameraPort({
    clockMs: async () => 0,
    createChannel: (listener) => listener,
    registerEvents: () => registration,
    async start({ attemptId }) { starts.push(attemptId); },
    async stop({ attemptId }) { stops.push(attemptId); },
  });
  const unsubscribe = await port.subscribe(() => {});
  const start = port.start("cancelled");
  unsubscribe();
  await port.stop("cancelled");
  await port.subscribe(() => {});
  const restart = port.start("replacement");
  acknowledge();
  await Promise.all([start, restart]);
  assert.deepEqual(starts, ["replacement"]);
  assert.deepEqual(stops, ["cancelled"]);
});
