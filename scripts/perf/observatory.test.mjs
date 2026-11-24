import assert from "node:assert/strict";
import test from "node:test";
import { SCHEMA, metric, unavailable, validateEvidence } from "./evidence.mjs";
import { initialAssets } from "./frontend.mjs";

const fixture = {
  schema: SCHEMA, capturedAt: "2026-11-24T19:00:00Z",
  source: { commit: "a".repeat(40), tree: "b".repeat(40), clean: true },
  environment: { platform: "linux", arch: "x64", context: "synthetic" },
  scenario: { id: "app.open", profile: "test", conditions: { warmup: 1 } },
  metrics: [metric("app.ready", "ms", "lower", [8, 3, 2, 10, 6]),
    unavailable("app.idle.rss", "bytes", "lower", "no device")],
};

test("retains raw trials and the existing nearest-rank sort with exact counts", () => {
  const verified = validateEvidence(structuredClone(fixture));
  assert.deepEqual(verified.metrics[0].samples, [8, 3, 2, 10, 6]);
  assert.deepEqual(verified.metrics[0].summary, { min: 2, count: 5, p50: 6, p95: 10, max: 10 });
});

test("rejects unscoped, partial, fabricated, duplicate and mixed unavailable evidence", () => {
  for (const mutate of [
    r => delete r.scenario.id,
    r => { r.source.commit = "abcd"; },
    r => { r.environment.platform = ""; },
    r => { r.metrics[0].summary.p95 = 5; },
    r => r.metrics.push(r.metrics[0]),
    r => { r.metrics[1].samples = [0]; },
    r => { r.metrics[0].samples[0] = Infinity; },
    r => delete r.metrics[1].reason,
  ]) {
    const receipt = structuredClone(fixture);
    mutate(receipt);
    assert.throws(() => validateEvidence(receipt));
  }
});

test("selects deduplicated static entry dependencies and never dynamic paths", () => {
  const assets = initialAssets({
    "index.html": { isEntry: true, file: "assets/app.js", imports: ["vendor", "shared"],
      dynamicImports: ["optional"], css: ["assets/app.css"] },
    vendor: { file: "assets/vendor.js", imports: ["shared"] },
    shared: { file: "assets/shared.js", css: ["assets/app.css", "assets/shared.css"] },
    optional: { file: "assets/optional.js", css: ["assets/optional.css"] },
  }, "index.html");
  assert.deepEqual(assets, { js: ["assets/app.js", "assets/shared.js", "assets/vendor.js"],
    css: ["assets/app.css", "assets/shared.css"] });
  assert.throws(() => initialAssets({ "index.html": { isEntry: true, file: "x", imports: ["absent"] } }, "index.html"));
});
