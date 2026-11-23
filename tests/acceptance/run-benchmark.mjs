import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { summarizeBenchmark } from "./benchmark.mjs";

const runFile = promisify(execFile);

export async function runBenchmark(config, executable, args = []) {
  const { commit, environment, payloadBytes, trialCount = 5, timeoutMs = 60000, compareProgress = false } = config;
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "record the full candidate SHA");
  assert.ok(typeof environment === "string" && environment.trim(), "record the test environment");
  assert.ok(Number.isSafeInteger(payloadBytes) && payloadBytes > 0, "invalid payloadBytes");
  assert.ok(Number.isInteger(trialCount) && trialCount >= 5 && trialCount <= 100, "use 5–100 trials");
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000, "invalid trial timeout");
  assert.equal(typeof compareProgress, "boolean");

  async function measure(index, mode) {
    const { stdout } = await runFile(executable, args, {
      env: {
        ...process.env,
        AERIFT_BENCH_TRIAL: String(index),
        AERIFT_BENCH_PROGRESS: mode,
        AERIFT_BENCH_PAYLOAD_BYTES: String(payloadBytes),
      },
      timeout: timeoutMs,
      maxBuffer: 65536,
      windowsHide: true,
    });
    const sample = JSON.parse(stdout);
    assert.equal(sample.integrityVerified, true, "verify saved contents in every run");
    assert.ok(Number.isFinite(sample.transferMs) && sample.transferMs > 0, "invalid transfer duration");
    return sample;
  }

  await measure(0, "on");
  if (compareProgress) await measure(0, "off");
  const trials = [];
  for (let index = 1; index <= trialCount; index++) {
    let baseline;
    if (compareProgress && index % 2 === 0) baseline = await measure(index, "off");
    const { connectionMs, transferMs, peakRssBytes, integrityVerified, gestureMs, uiInputMs } =
      await measure(index, "on");
    if (compareProgress && !baseline) baseline = await measure(index, "off");
    trials.push({
      connectionMs, transferMs, peakRssBytes, integrityVerified, gestureMs, uiInputMs,
      progressOffMs: baseline?.transferMs,
    });
  }
  const receipt = { commit, environment, payloadBytes, trials };
  return { receipt, summary: summarizeBenchmark(receipt) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , configPath, separator, executable, ...args] = process.argv;
  assert.ok(configPath && separator === "--" && executable,
    "usage: node run-benchmark.mjs <config.json> -- <executable> [args...]");
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    console.log(JSON.stringify(await runBenchmark(config, executable, args), null, 2));
  } catch (error) {
    // Child commands can include local paths and device details. Keep default failures concise.
    console.error(error.code ? `benchmark failed (${error.code})` :
      error.killed ? "benchmark trial timed out" : error.message);
    process.exitCode = 1;
  }
}
