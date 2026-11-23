import assert from "node:assert/strict";
import { test } from "node:test";
import { GestureIntent } from "../../dist/gestures/packages/gestures/src/intent.js";
import { WebGestureCamera } from "../../dist/gestures/packages/gestures/src/web-camera.js";

function hand(closed) {
  const point = (x, y) => ({ x, y, z: 0 });
  return [
    point(0.5, 0.66), point(0.44, 0.57), point(0.39, 0.52), point(0.37, 0.47),
    point(0.24, 0.33),
    ...[0.4, 0.46, 0.53, 0.6].flatMap(x => [
      point(x, 0.5), point(x, 0.43), point(x, 0.38), point(x, closed ? 0.49 : 0.33),
    ]),
  ];
}

function install(t, key, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  });
}

async function handleGesture(t, { inferenceMs, releaseMs = inferenceMs }) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);

  const received = [];
  const captures = [];
  let closed = false;
  let roundTripMs = inferenceMs;
  const track = Object.assign(new EventTarget(), {
    kind: "video",
    readyState: "live",
    stop() { this.readyState = "ended"; },
  });
  const video = {
    readyState: 2, style: {}, srcObject: null,
    get currentTime() { return Math.floor(now / 33) / 30; },
    async play() {}, pause() {},
  };
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus() { return true; },
  });
  install(t, "document", document);
  install(t, "window", new EventTarget());
  install(t, "location", new URL("http://tauri.localhost"));
  install(t, "screen", {});
  install(t, "isSecureContext", true);
  install(t, "navigator", { mediaDevices: { async getUserMedia() { return { getTracks: () => [track] }; } } });
  install(t, "OffscreenCanvas", class {});
  install(t, "createImageBitmap", async () => ({ close() {} }));
  install(t, "Worker", class {
    postMessage(data) {
      if (data.type === "INIT") {
        setTimeout(() => this.onmessage({ data: { type: "READY", generation: data.generation } }), 0);
        return;
      }
      captures.push(data.capture);
      const result = {
        type: "RESULT", generation: data.generation, capture: data.capture,
        width: 640, height: 480, hands: [hand(closed)],
      };
      setTimeout(() => this.onmessage({ data: result }), roundTripMs);
    }
    terminate() {}
  });

  const intent = new GestureIntent("web", { kind: "send", selectionId: "file", deviceId: "peer" },
    ({ action }) => received.push(action));
  const camera = new WebGestureCamera(intent, video, ({ phase }) => {
    if (phase === "ready") closed = true;
    if (phase === "held") {
      closed = false;
      roundTripMs = releaseMs;
    }
  });
  await camera.start({ workerUrl: new URL("/gesture-assets/hand-worker.js", location.href) });
  for (let elapsed = 0; elapsed < 2500; elapsed += 5) {
    now = elapsed + 5;
    t.mock.timers.tick(5);
    await Promise.resolve();
  }
  camera.stop();
  return { received, captures, interruption: intent.feedback.interruption };
}

test("an in-budget slow worker keeps the gesture paced through release", async (t) => {
  const gesture = await handleGesture(t, { inferenceMs: 100 });
  assert.deepEqual(gesture.received, ["arm", "release"]);
});

test("a fast worker stays within the planned camera cadence", async (t) => {
  const gesture = await handleGesture(t, { inferenceMs: 10 });
  assert.deepEqual(gesture.received, ["arm", "release"]);
  assert.ok(gesture.captures.slice(1).every((capture, index) => capture - gesture.captures[index] >= 64),
    "frames arrived sooner than the capture cadence");
});

test("late inference still interrupts without offering the selected file", async (t) => {
  const gesture = await handleGesture(t, { inferenceMs: 30, releaseMs: 180 });
  assert.deepEqual(gesture.received, ["arm", "interrupt"]);
  assert.match(gesture.interruption, /stale-frame|frame-gap/);
});
