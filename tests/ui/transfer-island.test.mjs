import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  activeIslandTransfers, observeIslandTransfers, readIslandMetrics, transferIslandSummary, transferMetricStaleMs,
} from "../../packages/ui/src/transfer-island-metrics.ts";

const file = { name: "Field survey.pdf", sizeBytes: 4000 };
const transfer = (overrides = {}) => ({ id: "one", direction: "outgoing", deviceId: "remote", file,
  state: "transferring", bytesTransferred: 0, ...overrides });
const receive = (overrides = {}) => transfer({ id: "two", direction: "incoming", ...overrides });
const observe = (previous, now, ...receipts) => observeIslandTransfers(previous, activeIslandTransfers(receipts), now);

test("the transfer island excludes offers, accepted receipts and all terminal records", () => {
  const statuses = ["pending", "accepted", "completed", "failed", "cancelled", "rejected"];
  const actual = transfer({ bytesTransferred: 1500 });
  assert.deepEqual(activeIslandTransfers([...statuses.map((state, i) => transfer({ id: String(i), state })), actual]), [actual]);
});

test("rates and ETA start unknown, then use real independent directional byte deltas", () => {
  const first = transfer({ bytesTransferred: 500 }), second = receive({ bytesTransferred: 2100 });
  const initial = observe(new Map(), 1000, first, second);
  assert.deepEqual(readIslandMetrics(first, initial.get(first.id), 1000), { percent: 12 });
  const next = transfer({ bytesTransferred: 1500 }), nextSecond = receive({ bytesTransferred: 2300 });
  const ready = observe(initial, 2000, next, nextSecond);
  assert.deepEqual(readIslandMetrics(next, ready.get(next.id), 2000), { percent: 37, bytesPerSecond: 1000, seconds: 2.5 });
  assert.deepEqual(readIslandMetrics(nextSecond, ready.get(nextSecond.id), 2000),
    { percent: 57, bytesPerSecond: 200, seconds: 8.5 });
  assert.deepEqual(transferIslandSummary([next, nextSecond]), { count: 2, incoming: 1, outgoing: 1, percent: 47 });
});

test("sub-quarter-second bursts accumulate; identical snapshots neither invent speed nor reset freshness", () => {
  const state = observe(new Map(), 0, transfer());
  const fast = transfer({ bytesTransferred: 80 });
  const afterFast = observe(state, 100, fast);
  assert.deepEqual(readIslandMetrics(fast, afterFast.get(fast.id), 100), { percent: 2 });
  const stable = transfer({ bytesTransferred: 320 });
  const afterStable = observe(afterFast, 400, stable);
  assert.equal(readIslandMetrics(stable, afterStable.get(stable.id), 400).bytesPerSecond, 800);
  const stale = observe(afterStable, 400 + transferMetricStaleMs, stable);
  assert.deepEqual(readIslandMetrics(stable, stale.get(stable.id), 400 + transferMetricStaleMs), { percent: 8 });
});

test("long pauses, byte rollback and clock reset require a new sample before showing a rate", () => {
  const slow = transfer({ bytesTransferred: 1000 });
  const measured = observe(observe(new Map(), 0, transfer()), 500, slow);
  const more = transfer({ bytesTransferred: 2000 });
  const retry = observe(measured, 500 + transferMetricStaleMs, more);
  assert.deepEqual(readIslandMetrics(more, retry.get(more.id), 500 + transferMetricStaleMs), { percent: 50 });
  const lower = transfer({ bytesTransferred: 250 });
  assert.deepEqual(readIslandMetrics(lower, observe(measured, 600, lower).get(lower.id), 600), { percent: 6 });
  assert.deepEqual(readIslandMetrics(more, observe(measured, 200, more).get(more.id), 200), { percent: 50 });
});

test("all received bytes are still awaiting verification and empty/invalid totals never invent a percentage", () => {
  const full = transfer({ bytesTransferred: 4000 });
  const measured = observe(observe(new Map(), 0, transfer()), 500, full);
  assert.deepEqual(readIslandMetrics(full, measured.get(full.id), 500), { percent: 100 });
  const empty = transfer({ file: { ...file, sizeBytes: 0 } });
  const invalid = transfer({ file: { ...file, sizeBytes: NaN }, bytesTransferred: Infinity });
  assert.deepEqual(readIslandMetrics(empty, undefined, 1), {});
  assert.deepEqual(readIslandMetrics(invalid, undefined, 1), {});
  assert.equal(transferIslandSummary([full, empty]).percent, undefined);
  assert.equal(observe(measured, 600).size, 0);
});

test("the island reads live transfers at the shared desktop and mobile entry, and owns motion/safe area", () => {
  const workspace = readFileSync(new URL("../../packages/ui/src/TransferWorkspace.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../../packages/ui/src/transfer-island.css", import.meta.url), "utf8");
  assert.match(workspace, /<TransferIsland transfers=\{snapshot\?\.transfers\}/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(styles, /safe-area-inset-bottom/);
});
