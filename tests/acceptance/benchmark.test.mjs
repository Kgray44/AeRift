import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeBenchmark } from "./benchmark.mjs";

function example() {
  return {
    commit: "a".repeat(40),
    environment: "synthetic analyzer fixture",
    payloadBytes: 2 ** 20,
    trials: [1000, 500, 250, 125, 100].map((transferMs) => ({
      connectionMs: 10,
      transferMs,
      peakRssBytes: 2 ** 20,
      progressOffMs: transferMs + 1,
      integrityVerified: true,
    })),
  };
}

test("computes MiB/s and signed paired progress overhead", () => {
  const { metrics } = summarizeBenchmark(example());
  assert.deepEqual(metrics.throughputMiBPerSecond, { count: 5, p50: 4, p95: 10, max: 10 });
  assert.deepEqual(metrics.progressOverheadMs, { count: 5, p50: -1, p95: -1, max: -1 });
  assert.equal(metrics.gestureMs, undefined);
});

test("requires measured durations, integrity, and consistent instrumentation", () => {
  const badTiming = example();
  badTiming.trials[0].transferMs = 0;
  assert.throws(() => summarizeBenchmark(badTiming), /duration/);
  const corrupted = example();
  corrupted.trials[0].integrityVerified = false;
  assert.throws(() => summarizeBenchmark(corrupted), /saved contents/);
  const partial = example();
  partial.trials[0].uiInputMs = 5;
  assert.throws(() => summarizeBenchmark(partial), /incomplete uiInputMs/);
});
