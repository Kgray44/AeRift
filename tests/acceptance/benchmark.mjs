import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}

export function summarizeBenchmark(receipt) {
  const { commit, environment, payloadBytes, trials } = receipt;
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "record the full candidate SHA");
  assert.ok(typeof environment === "string" && environment.trim(), "record the test environment");
  assert.ok(Number.isSafeInteger(payloadBytes) && payloadBytes > 0, "invalid payloadBytes");
  assert.ok(Array.isArray(trials) && trials.length >= 5, "record at least five measured trials");

  const measurements = new Map();
  function record(name, value, minimum = 0) {
    assert.ok(Number.isFinite(value) && value >= minimum, `invalid ${name}`);
    if (!measurements.has(name)) measurements.set(name, []);
    measurements.get(name).push(value);
  }
  for (const trial of trials) {
    assert.equal(trial.integrityVerified, true, "verify saved contents in every trial");
    assert.ok(Number.isFinite(trial.transferMs) && trial.transferMs > 0, "transfer duration must be positive");
    record("connectionMs", trial.connectionMs);
    record("throughputMiBPerSecond", payloadBytes / 1048576 / (trial.transferMs / 1000));
    record("peakRssBytes", trial.peakRssBytes, 1);
    if (trial.progressOffMs !== undefined) {
      assert.ok(Number.isFinite(trial.progressOffMs) && trial.progressOffMs > 0,
        "invalid paired progress-off duration");
      const overhead = trial.transferMs - trial.progressOffMs;
      record("progressOverheadMs", overhead, -Infinity);
    }
    if (trial.gestureMs !== undefined) record("gestureMs", trial.gestureMs);
    if (trial.uiInputMs !== undefined) record("uiInputMs", trial.uiInputMs);
  }
  const metrics = {};
  for (const [name, values] of measurements) {
    assert.equal(values.length, trials.length, `incomplete ${name} coverage`);
    metrics[name] = distribution(values);
  }
  return { commit, environment, payloadBytes, metrics };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "usage: node benchmark.mjs <measured-receipt.json>");
  const receipt = JSON.parse(await readFile(process.argv[2], "utf8"));
  console.log(JSON.stringify(summarizeBenchmark(receipt), null, 2));
}
