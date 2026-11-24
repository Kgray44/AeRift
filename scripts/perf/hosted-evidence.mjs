import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SCHEMA, metric, unavailable, validateEvidence } from "./evidence.mjs";

const checks = {
  windows: {
    context: "runner-owned Windows installed-shell NSIS smoke",
    arch: "x64",
    profile: "windows-nsis-installed-shell",
    visible: "startup.windows.home-observed",
    teardown: "teardown.windows.forced-app-exit-observed",
    timing: ["startup.windows.home-observed", "startup.windows.webview-fcp",
      "teardown.windows.forced-app-exit-observed"],
  },
  ios: {
    context: "runner-owned iOS simulator",
    profile: "ios-iphone-simulator",
    visible: "startup.ios.workspace-observed",
    timing: ["startup.ios.workspace-observed"],
  },
  android: {
    context: "runner-owned Android x86_64 SDK emulator",
    arch: "x64",
    profile: "android-sdk-emulator",
    visible: "startup.android.workspace-observed",
    teardown: "teardown.android.force-stopped-app-exit-observed",
    timing: ["startup.android.workspace-observed", "startup.android.activity-manager-total",
      "teardown.android.force-stopped-app-exit-observed"],
  },
};

function prove(platform, source, smoke, log) {
  if (platform === "windows") {
    assert.equal(smoke?.commit, source.commit, "different Windows checked-out revision");
    assert.equal(smoke.installed, true, "NSIS install unproven");
    assert.equal(smoke.simplifiedHomeAndOrbit, true, "Windows Home shell unobserved");
    assert.equal(smoke.fullWorkspace, true, "Windows workspace unobserved");
    assert.match(smoke.sha256 ?? "", /^[0-9a-f]{64}$/i, "installer hash required");
  } else if (platform === "ios") {
    assert.equal(smoke?.checkedOutAppCommit, source.commit, "different simulator checked-out revision");
    assert.equal(smoke.appSourceCommit, source.commit, "different intended simulator source");
    assert.equal(smoke.installed, true);
    assert.equal(smoke.workspaceVisible, true, "simulator workspace unobserved");
    assert.equal(smoke.launchSmokePassed, true);
    assert.equal(smoke.physicalDeviceValidated, false, "this adapter only accepts a simulator");
  } else {
    assert.equal(smoke, null, "Android smoke uses the exact workflow job marker, not a receipt");
    assert.ok(/^Android API \d+: production workspace launched; system Files picker staged synthetic fixture; no send issued\.$/m
      .test(payloadLines(log).join("\n")), "Android production workspace / local fixture marker missing");
  }
}

function payloadLines(log) {
  return log.split(/\r?\n/).map(line => line.replace(/^\d{4}-\d\d-\d\dT[0-9:.]+Z /, ""));
}

function observations(log, allowed) {
  const values = new Map();
  for (const line of payloadLines(log)) {
    if (!line.startsWith("AERIFT_PERF ")) continue;
    const sample = /^AERIFT_PERF ([\w.-]+)=([0-9]+(?:\.[0-9]+)?)$/.exec(line);
    assert.ok(sample, "invalid hosted observation line");
    const [, key, value] = sample;
    assert.ok(allowed.includes(key) && !values.has(key), "unexpected or duplicated hosted observation");
    values.set(key, Number(value));
  }
  return values;
}

export function ingestHostedEvidence(provenance, smoke, log = "") {
  const { platform, arch, source, run, capturedAt } = provenance;
  assert.ok(typeof platform === "string" && Object.hasOwn(checks, platform), "unsupported hosted platform");
  const target = checks[platform];
  assert.ok(["x64", "arm64"].includes(arch) && (!target.arch || target.arch === arch), "runner architecture missing or unexpected");
  assert.equal(run?.headSha, source?.commit, "workflow head differs from candidate");
  assert.equal(run?.conclusion, "success", "positive smoke requires a successful exact workflow job");
  const allowedJobs = { windows: "installer", ios: "iOS simulator - Tauri app build and launch", android: "android-emulator" };
  assert.equal(run.jobName, allowedJobs[platform], "wrong hosted smoke job");
  assert.match(run.id ?? "", /^[1-9]\d+$/);
  assert.match(run.jobId ?? "", /^[1-9]\d+$/);
  prove(platform, source, smoke, log);
  const seen = observations(log, target.timing);
  const optional = (id, reason) => seen.has(id)
    ? metric(id, "ms", "lower", [seen.get(id)])
    : unavailable(id, "ms", "lower", reason);
  return validateEvidence({
    schema: SCHEMA, capturedAt, source,
    environment: { platform, arch, context: target.context },
    scenario: {
      id: "hosted." + platform + ".shell-qualification",
      profile: target.profile,
      conditions: {
        hosted: true, physicalDevice: false, cameraUsed: false,
        workflowRunId: run.id, workflowJobId: run.jobId,
        sampling: "one process per workflow smoke; no repeated timing distribution or budget gate",
        observation: "positive sampled shell state is an upper bound with host probe latency, not first paint",
        teardown: "forced app PID exit only, not graceful quit or native resource release",
      },
    },
    metrics: [
      metric("hosted.shell-visible-checks", "count", "informational", [1]),
      optional(target.visible, "Historical hosted smoke verified shell visibility without an elapsed marker."),
      optional("startup.windows.webview-fcp", "No runner-owned WebView first-contentful-paint timing for this receipt."),
      ...(platform === "android" ? [optional("startup.android.activity-manager-total", "No Android ActivityManager TotalTime sample.")] : []),
      unavailable("startup.receiver.ready", "ms", "lower", "No explicit native receive-ready acknowledgement and authenticated paired observation measured."),
      ...(target.teardown ? [optional(target.teardown, "No verified forced process-exit timing in this hosted receipt.")] : []),
      unavailable("teardown.camera.released", "ms", "lower", "Camera was not started; no device/driver release trace."),
      unavailable("teardown.native.resources-released", "ms", "lower", "Host smoke does not measure idle leases, listener lifetime, or graceful resource release."),
      unavailable("app.navigation.frame-p95", "ms/frame", "lower", "No frame timestamps/paint trace; screenshot and launch time do not provide frame pacing."),
      unavailable("gesture.edge-to-paint", "ms", "lower", "No real landmark/physical gesture event and corresponding paint trace."),
    ],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [provenance, smoke, jobLog] = process.argv.slice(2);
  assert.ok(provenance && smoke, "usage: node scripts/perf/hosted-evidence.mjs provenance.json <smoke.json|-> [exact-job.log]");
  const json = async (name) => JSON.parse((await readFile(name, "utf8")).replace(/^\uFEFF/, ""));
  const evidence = ingestHostedEvidence(await json(provenance), smoke === "-" ? null : await json(smoke),
    jobLog ? await readFile(jobLog, "utf8") : "");
  console.log(JSON.stringify(evidence, null, 2));
}
