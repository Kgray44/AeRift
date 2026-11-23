import assert from "node:assert/strict";
import { test } from "node:test";
import { GestureIntent } from "../../dist/gestures/packages/gestures/src/intent.js";
import { HandLandmarkTracker } from "../../dist/gestures/packages/gestures/src/landmarks.js";

// Synthetic landmark fixtures adapted from VoyageWright chart-transfer-gesture.test.ts.
function hand(closed = 0, mirror = false) {
  const point = (x, y) => ({ x: mirror ? 1 - x : x, y, z: 0 });
  return [
    point(0.5, 0.66), point(0.44, 0.57), point(0.39, 0.52), point(0.37, 0.47),
    point(0.24, 0.33),
    ...[0.4, 0.46, 0.53, 0.6].flatMap((x, i) => [
      point(x, 0.5), point(x, 0.43), point(x, 0.38), point(x, closed > i ? 0.49 : 0.33),
    ]),
  ];
}

function setup({ mirror = false, mode = "send", initialCamera = "ready" } = {}) {
  const tracker = new HandLandmarkTracker();
  const commands = [];
  const context = mode === "send"
    ? { kind: "send", selectionId: "file", deviceId: "peer" }
    : { kind: "receive", transferId: "incoming" };
  const intent = new GestureIntent("gesture-1", context, (command, bound) => {
    commands.push([command.action, command.intentId, bound]);
  });
  intent.setCamera(initialCamera);
  const sample = (at, closed, options = {}) => {
    const hands = closed == null ? [] : [hand(closed, mirror)];
    if (options.two) hands.push(hand(0));
    if (options.invalid) hands[0][8].x = NaN;
    if (options.jump) hands[0] = hands[0].map((p) => ({ ...p, x: p.x + 0.3 }));
    const observation = tracker.observe({
      captureMs: at, width: options.width ?? 640, height: 480, hands,
    });
    return intent.observe(observation, at + (options.delay ?? 10));
  };
  const ready = () => [10, 80, 150, 220].forEach((at) => sample(at, 0));
  const grasp = () => [290, 360, 430].forEach((at) => sample(at, 4));
  const release = () => [500, 570, 640].forEach((at) => sample(at, 0));
  return { intent, commands, context, sample, ready, grasp, release };
}

for (const mirror of [false, true]) {
  test(`stable open, fist, and reopen dispatch once (mirrored=${mirror})`, () => {
    const s = setup({ mirror });
    s.ready();
    assert.equal(s.intent.feedback.phase, "ready");
    s.grasp();
    assert.equal(s.intent.feedback.phase, "held");
    s.release();
    s.sample(710, 0);
    s.intent.cancel();
    s.ready();
    s.grasp();
    s.release();
    assert.equal(s.intent.feedback.phase, "released");
    assert.deepEqual(s.commands, [
      ["arm", "gesture-1", s.context], ["release", "gesture-1", s.context],
    ]);
  });
}

test("receive binds a single explicitly chosen offer and requires the full sequence", () => {
  const s = setup({ mode: "receive" });
  [10, 80, 150, 220].forEach((at) => s.sample(at, 4));
  assert.deepEqual(s.commands, []);
  [290, 360, 430, 500].forEach((at) => s.sample(at, 0));
  [570, 640, 710].forEach((at) => s.sample(at, 4));
  [780, 850, 920].forEach((at) => s.sample(at, 0));
  assert.deepEqual(s.commands.map(([action, , bound]) => [action, bound]), [
    ["arm", s.context], ["release", s.context],
  ]);
});

test("brief fist and brief reopening do not advance stable phases", () => {
  const s = setup();
  s.ready();
  s.sample(260, 4);
  s.sample(280, 2);
  assert.deepEqual(s.commands, []);
  s.grasp();
  s.sample(510, 0);
  s.sample(580, 2);
  assert.deepEqual(s.commands.map(([action]) => action), ["arm"]);
  [650, 720, 790].forEach((at) => s.sample(at, 0));
  assert.deepEqual(s.commands.map(([action]) => action), ["arm", "release"]);
});

const interruptionCases = {
  "lost hand": (s) => s.sample(500, null),
  "two hands": (s) => s.sample(500, 0, { two: true }),
  "tracking jump": (s) => s.sample(500, 0, { jump: true }),
  "missing landmark": (s) => s.sample(500, 0, { invalid: true }),
  "frame resize": (s) => s.sample(500, 0, { width: 720 }),
  "capture gap": (s) => s.sample(700, 0),
  "stale inference": (s) => s.sample(500, 0, { delay: 155 }),
  "reordered frame": (s) => s.sample(420, 0),
  "changed target": (s) => s.intent.updateContext({ ...s.context, deviceId: "other" }),
  "changed file": (s) => s.intent.updateContext({ ...s.context, selectionId: "other" }),
  "window blur": (s) => s.intent.setCamera("suspended"),
  "camera revoked": (s) => s.intent.setCamera("denied"),
  "explicit cancellation": (s) => s.intent.cancel(),
  "silence": (s) => s.intent.tick(651),
  "held deadline": (s) => {
    for (let at = 500; at <= 3500; at += 100) s.sample(at, 4);
  },
};
for (const [reason, interrupt] of Object.entries(interruptionCases)) {
  test(`${reason} interrupts an armed transfer and subsequent observations cannot send`, () => {
    const s = setup();
    s.ready();
    s.grasp();
    interrupt(s);
    s.release();
    assert.equal(s.intent.feedback.phase, "interrupted");
    assert.deepEqual(s.commands.map(([action]) => action), ["arm", "interrupt"]);
  });
}

test("permission denial keeps recognition disabled", () => {
  const s = setup({ initialCamera: "denied" });
  s.ready();
  s.grasp();
  s.release();
  assert.equal(s.intent.feedback.camera, "denied");
  assert.deepEqual(s.commands.map(([action]) => action), ["interrupt"]);
});

test("low measured landmark confidence is distinct from unreported confidence", () => {
  const tracker = new HandLandmarkTracker();
  const frame = { captureMs: 10, width: 640, height: 480 };
  assert.equal(tracker.observe({ ...frame, hands: [hand()] }).confidence, null);
  const uncertain = hand().map((p, i) => ({ ...p, confidence: i === 8 ? 0.1 : 0.9 }));
  assert.equal(tracker.observe({ ...frame, captureMs: 80, hands: [uncertain] }).posture, "unusable");
});

test("an activated attempt expires while continuous frames see no hand", () => {
  const s = setup();
  s.intent.begin(0);
  for (let at = 100; at < 30_000; at += 100) s.sample(at, null);
  assert.equal(s.intent.feedback.phase, "acquiring");
  assert.equal(s.intent.tick(30_000).phase, "interrupted");
  s.ready();
  s.grasp();
  s.release();
  assert.deepEqual(s.commands.map(([action]) => action), ["interrupt"]);
});
