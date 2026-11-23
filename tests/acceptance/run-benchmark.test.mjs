import assert from "node:assert/strict";
import { test } from "node:test";
import { runBenchmark } from "./run-benchmark.mjs";

const config = { commit: "b".repeat(40), environment: "runner self-test", payloadBytes: 1048576 };

test("starts fresh driver processes, discards warmups, and records paired measurements", async () => {
  const script = [
    "const index = Number(process.env.AERIFT_BENCH_TRIAL)",
    "const progress = process.env.AERIFT_BENCH_PROGRESS === 'on'",
    "const bytes = Number(process.env.AERIFT_BENCH_PAYLOAD_BYTES)",
    "console.log(JSON.stringify({connectionMs:index, transferMs:progress ? 5 : 4,",
    "peakRssBytes:99, integrityVerified:bytes===1048576}))",
  ].join("\n");
  const { receipt, summary } = await runBenchmark(
    { ...config, compareProgress: true }, process.execPath, ["-e", script],
  );
  assert.deepEqual(receipt.trials.map((trial) => trial.connectionMs), [1, 2, 3, 4, 5]);
  assert.equal(summary.metrics.progressOverheadMs.p50, 1);
});

test("rejects unverified warmup and invalid configuration before retaining measurements", async () => {
  await assert.rejects(
    runBenchmark(config, process.execPath, ["-e", "console.log('{\"integrityVerified\":false}')"]),
    /verify saved contents/,
  );
  await assert.rejects(runBenchmark({ ...config, trialCount: 4 }, process.execPath), /5–100 trials/);
});
