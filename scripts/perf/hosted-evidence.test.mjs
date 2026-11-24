import assert from "node:assert/strict";
import test from "node:test";
import { ingestHostedEvidence } from "./hosted-evidence.mjs";

const commit = "a".repeat(40);
const source = { commit, tree: "b".repeat(40), clean: true };
const jobs = {
  windows: "installer",
  ios: "iOS simulator - Tauri app build and launch",
  android: "android-emulator",
};
const proof = (platform) => ({
  platform, arch: platform === "ios" ? "arm64" : "x64", source,
  capturedAt: "2026-11-24T19:00:00Z",
  run: { id: "123", jobId: "456", jobName: jobs[platform], headSha: commit, conclusion: "success" },
});
const windows = {
  commit, installed: true, sha256: "c".repeat(64), simplifiedHomeAndOrbit: true, fullWorkspace: true,
};
const ios = {
  appSourceCommit: commit, checkedOutAppCommit: commit, installed: true, workspaceVisible: true,
  launchSmokePassed: true, physicalDeviceValidated: false,
};
const android = "2026-11-24T19:00:00.1234567Z Android API 36: production workspace launched; system Files picker staged synthetic fixture; no send issued.";
const find = (evidence, id) => evidence.metrics.find(item => item.id === id);

test("historical smoke only proves shell observation, not startup latency, receiver readiness or teardown", () => {
  for (const [platform, receipt, log] of [["windows", windows, ""], ["ios", ios, ""], ["android", null, android]]) {
    const evidence = ingestHostedEvidence(proof(platform), receipt, log);
    assert.equal(evidence.environment.platform, platform);
    assert.equal(evidence.scenario.conditions.physicalDevice, false);
    assert.equal(evidence.metrics.filter(metric => metric.status === "measured").length, 1);
    assert.deepEqual(find(evidence, "hosted.shell-visible-checks").samples, [1]);
    for (const id of ["startup.receiver.ready", "teardown.camera.released",
      "teardown.native.resources-released", "app.navigation.frame-p95", "gesture.edge-to-paint"]) {
      assert.equal(find(evidence, id).status, "unavailable");
      assert.ok(!("samples" in find(evidence, id)));
    }
  }
});

test("optional observations keep independent clock/meaning and do not infer native readiness", () => {
  const desktop = ingestHostedEvidence(proof("windows"), windows, [
    "2026-11-24T19:00:00.1234567Z AERIFT_PERF startup.windows.home-observed=1650",
    "AERIFT_PERF startup.windows.webview-fcp=104.125",
    "AERIFT_PERF teardown.windows.forced-app-exit-observed=35",
  ].join("\n"));
  assert.deepEqual(find(desktop, "startup.windows.home-observed").samples, [1650]);
  assert.deepEqual(find(desktop, "startup.windows.webview-fcp").samples, [104.125]);
  assert.equal(find(desktop, "startup.receiver.ready").status, "unavailable");
  const simulator = ingestHostedEvidence(proof("ios"), ios, "AERIFT_PERF startup.ios.workspace-observed=5920");
  assert.deepEqual(find(simulator, "startup.ios.workspace-observed").samples, [5920]);
  const emulator = ingestHostedEvidence(proof("android"), null, android + "\n" +
    "AERIFT_PERF startup.android.activity-manager-total=417\n" +
    "AERIFT_PERF startup.android.workspace-observed=2140\n" +
    "AERIFT_PERF teardown.android.force-stopped-app-exit-observed=143");
  assert.deepEqual(find(emulator, "startup.android.activity-manager-total").samples, [417]);
  assert.deepEqual(find(emulator, "startup.android.workspace-observed").samples, [2140]);
  assert.deepEqual(find(emulator, "teardown.android.force-stopped-app-exit-observed").samples, [143]);
  assert.equal(find(emulator, "teardown.native.resources-released").status, "unavailable");
});

test("rejects stale, failed, incompatible and ambiguous qualification receipts", () => {
  assert.throws(() => ingestHostedEvidence(proof("windows"), { ...windows, commit: "d".repeat(40) }), /different Windows/);
  assert.throws(() => ingestHostedEvidence(proof("ios"), { ...ios, physicalDeviceValidated: true }), /only accepts a simulator/);
  assert.throws(() => ingestHostedEvidence(proof("android"), null, "Status: ok"), /marker missing/);
  const candidate = proof("android");
  assert.throws(() => ingestHostedEvidence({ ...candidate, run: { ...candidate.run, conclusion: "failure" } }, null, android));
  assert.throws(() => ingestHostedEvidence({ ...candidate, run: { ...candidate.run, headSha: "d".repeat(40) } }, null, android));
  assert.throws(() => ingestHostedEvidence({ ...candidate, run: { ...candidate.run, jobName: jobs.ios } }, null, android));
  assert.throws(() => ingestHostedEvidence(proof("ios"), ios, "AERIFT_PERF startup.windows.webview-fcp=73"));
  assert.throws(() => ingestHostedEvidence(proof("ios"), ios,
    "AERIFT_PERF startup.ios.workspace-observed=12\nAERIFT_PERF startup.ios.workspace-observed=99"));
});
