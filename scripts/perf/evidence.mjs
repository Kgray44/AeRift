import assert from "node:assert/strict";
import { distribution } from "../../tests/acceptance/benchmark.mjs";

export const SCHEMA = "aerift.performance/v1";
const metricId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const directions = new Set(["lower", "higher", "informational"]);
const units = new Set(["ms", "bytes", "ms/frame", "frames/s", "MiB/s", "percent", "count", "mWh", "joules"]);
const label = (v) => typeof v === "string" && v.trim().length > 0;
const isMetricId = (v) => typeof v === "string" && metricId.test(v);
const sha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);

export function metric(id, unit, direction, samples) {
  assert.ok(Array.isArray(samples) && samples.length > 0 && samples.length <= 100, id);
  assert.ok(samples.every((v) => Number.isFinite(v) && v >= 0), id);
  return { id, unit, direction, status: "measured", samples: [...samples],
    summary: { min: Math.min(...samples), ...distribution(samples) } };
}

export function unavailable(id, unit, direction, reason) {
  assert.ok(label(reason), id);
  return { id, unit, direction, status: "unavailable", reason };
}

export function validateEvidence(receipt) {
  const { schema, capturedAt, source, environment, scenario, metrics } = receipt ?? {};
  assert.equal(schema, SCHEMA);
  assert.ok(typeof capturedAt === "string" && Number.isFinite(Date.parse(capturedAt)), "UTC observation timestamp required");
  assert.ok(capturedAt.endsWith("Z"), "use UTC for capturedAt");
  assert.ok(sha(source?.commit) && sha(source?.tree) && typeof source.clean === "boolean",
    "full commit, tree and worktree status required");
  assert.ok(label(environment?.platform) && label(environment.arch) && label(environment.context),
    "actual OS, architecture and context required");
  assert.ok(scenario && isMetricId(scenario.id) && label(scenario.profile)
    && scenario.conditions && typeof scenario.conditions === "object" && !Array.isArray(scenario.conditions),
    "named scenario, profile and conditions required");
  assert.ok(Array.isArray(metrics) && metrics.length > 0, "metrics required");
  const ids = new Set();
  for (const item of metrics) {
    assert.ok(item && isMetricId(item.id) && directions.has(item.direction) && units.has(item.unit), "invalid metric descriptor");
    assert.ok(!ids.has(item.id), `duplicate metric: ${item.id}`);
    ids.add(item.id);
    if (item.status === "unavailable") {
      assert.deepEqual(item, unavailable(item.id, item.unit, item.direction, item.reason));
    } else {
      assert.deepEqual(item, metric(item.id, item.unit, item.direction, item.samples));
    }
  }
  return receipt;
}

if (process.argv[1]) {
  const { pathToFileURL } = await import("node:url");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { readFile } = await import("node:fs/promises");
    const files = process.argv.slice(2);
    assert.ok(files.length > 0, "usage: node scripts/perf/evidence.mjs <receipt.json> [...]");
    for (const file of files) {
      const receipt = validateEvidence(JSON.parse(await readFile(file, "utf8")));
      console.log(`${receipt.scenario.id} ${receipt.source.commit} ${receipt.environment.platform} ${receipt.metrics.length} metrics`);
    }
  }
}
