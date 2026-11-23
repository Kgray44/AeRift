import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeUiTiming } from "./ui-timing.mjs";

function fixture() {
  const idle = [0, 10, 20, 30, 40].map((delay, index) => ({
    inputMs: index * 1000,
    responseMs: index * 1000 + delay,
    observedThroughMs: index * 1000 + 50,
  }));
  return {
    commit: "a".repeat(40),
    platform: "windows",
    environment: "synthetic test fixture",
    action: "open Settings",
    capture: "synthetic timestamps",
    observationMs: 500,
    idle,
    streaming: idle.map((sample) => ({ ...sample })),
  };
}

test("records responsive timings and missed actions separately", () => {
  const receipt = fixture();
  receipt.streaming[4] = { inputMs: 4000, responseMs: null, observedThroughMs: 4500 };
  const result = summarizeUiTiming(receipt);
  assert.deepEqual(result.idle, {
    attempted: 5, missed: 0, inputToRenderMs: { count: 5, p50: 20, p95: 40, max: 40 },
  });
  assert.deepEqual(result.streaming, {
    attempted: 5, missed: 1, inputToRenderMs: { count: 4, p50: 10, p95: 30, max: 30 },
  });
});

test("rejects a missing result with insufficient observation and invalid frame order", () => {
  const receipt = fixture();
  receipt.streaming[1].responseMs = null;
  assert.throws(() => summarizeUiTiming(receipt), /incomplete missed-action observation/);
  receipt.streaming[1].responseMs = 999;
  assert.throws(() => summarizeUiTiming(receipt), /outside the observed interval/);
  receipt.streaming.pop();
  assert.throws(() => summarizeUiTiming(receipt), /at least five actions/);
});
