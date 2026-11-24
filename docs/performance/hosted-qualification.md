# P9 runner-owned qualification

P9 extends the [observatory evidence contract](README.md), not the app.
The existing Windows installer, iPhone simulator and Android SDK emulator
smokes are the only collection owners here. No workflow was changed to
enable collection by default. No device, signing key, release, telemetry
service, or camera permission is needed for this lane.

## Verified historical intake

The following receipts were normalized from successful exact workflow
head `353e5ebfc57acf50037ee81217042508bb481a81`, tree
`8679c8035439628f777e44468f2ab602df43de95`. They prove one **observed shell
smoke** each, not timing. Those jobs ran before the optional timing
markers were added. Their recorded UTC time is the originating job's
completion time.

| Runner | Origin | Normalized receipt |
|---|---|---|
| Windows x64 | [Installer job 138731618746](https://github.com/Kgray44/AeRift/actions/runs/45474678206/job/138731618746), successful NSIS receipt from job stdout | [Windows](qualification/353e5ebf-windows-runner.json) |
| iOS simulator, arm64 host | [Simulator job 138731618818](https://github.com/Kgray44/AeRift/actions/runs/45474678208/job/138731618818), checked-out commit and visibility in artifact `14961421936` | [iOS](qualification/353e5ebf-ios-simulator.json) |
| Android API 36 x64 emulator | [SDK emulator job 138731616582](https://github.com/Kgray44/AeRift/actions/runs/45474677873/job/138731616582), exact successful synthetic Files-picker marker | [Android](qualification/353e5ebf-android-emulator.json) |

Read the exact revision, tree, workflow and job IDs from the platform CI
record before adapting. A PR title or artifact filename is not revision
provenance. Adapter rejects job failures, a mismatched revision or job type,
and duplicate/foreign timing markers. The provenance JSON shape is:

```json
{
  "platform": "windows",
  "arch": "x64",
  "capturedAt": "<originating job completed UTC timestamp>",
  "source": { "commit": "<full head SHA>", "tree": "<full Git tree SHA>", "clean": true },
  "run": {
    "id": "<workflow run ID>",
    "jobId": "<exact job ID>",
    "jobName": "installer",
    "headSha": "<same full head SHA>",
    "conclusion": "success"
  }
}
```

Use the existing `windows-launch.json` or iOS artifact `receipt.json`.
Android does not have a separate app artifact receipt; use `-` and its
exact successful job stdout. The optional job log is the source of timing
markers if the runner collected them. Pass just the exact scope of the
smoke job or its sanitized equivalent. Do not retain raw screenshots,
full console dumps, UDIDs, local paths, or installer binaries with the
normalized JSON.

```sh
node scripts/perf/hosted-evidence.mjs provenance.json smoke.json exact-job.log > hosted-evidence.json
node scripts/perf/evidence.mjs hosted-evidence.json
node --test scripts/perf/hosted-evidence.test.mjs
```

## Prospective runner-only timing

Set `AERIFT_PERF_OBSERVE=1` for the existing isolated smoke invocation
only. The regular workflows leave it unset; these observations were not
run on the platform hosts for this patch. No conclusion can be made about
physical devices, cold disk caches, power, or native app latency budgets.
Only one observation per metric is emitted; use separately scoped,
repeated cold/warm trials before comparing latency.

| Runner and prerequisites | Supported observation | Scope limits |
|---|---|---|
| Existing Windows x64 NSIS workflow runner, exact previously built installer and Windows WebView2; call `apps/windows/Test-InstalledShell.ps1` within its disposable runner profile | Process-start-to-positive Home/Orbit CDP condition; optionally renderer navigation **first-contentful-paint**; actual main process forced-exit observation | DOM condition includes probe/poll delay and is not first paint. Renderer FCP is relative to navigation, not process launch. Forced exit checks only that process, not graceful stop, listener or WebView resources. |
| Dedicated macOS runner and installed Xcode iPhone simulator through `apps/ios/simulator-smoke.sh`, no physical device or team signing | Launch command to first positive workspace screenshot heuristic using host monotonic time | Upper bound includes launcher, fixed five-second survival check and screenshot-probe cadence; not paint latency. No simulator/app forced teardown added. |
| SDK emulator runner, empty adb inventory, disposable API 36 x86_64 emulator with camera disabled, existing exact debug APK via `apps/android/emulator-smoke.sh` | `am start -W` ActivityManager TotalTime (if provided); launch-to-first-positive accessibility Workspace check; force-stopped app PID observed absent | ActivityManager duration is OS-specific, not WebView paint. Accessibility dump includes probe latency. Optional force-stop occurs only inside the already verified owned emulator and after existing smoke assertions. |

## Explicitly missing qualification

- **Receiver readiness:** a shell render, subscription, or app process does
  not authorize receiving. Instrument the explicit Prepare-to-Receive
  local action, successful native `set_receiver_ready(true)` and the
  subsequent authenticated paired sender readiness query. Keep the
  declared start point and one monotonic domain or use independently
  scoped intervals. Verify the state still cannot accept an incoming
  offer and revoke it after the test. No instrumentation of this boundary
  is included yet.
- **Motion and gesture latency:** collect an actual frame-time series from
  the installed renderer and compare the same scenario idle vs. transfer.
  Reuse the [UI observation contract](../../tests/acceptance/ui-timing.mjs)
  for real input-to-render evidence. Gesture edge-to-paint additionally
  needs trusted model/input timings, consent, trace alignment, and a
  real prepared fixture. A screenshot, WebView FCP or simulator runtime
  is not a gesture or frame pacing measurement.
- **Resource release:** hosted process absence cannot prove native
  foreground policy, camera lease release, shutdown on lock/unplug,
  socket/discovery worker quiescence, optional feature parking, resource
  ownership or energy. Coordinate P1/P3 on isolated process-tree/worker/
  provider instrumentation first. Then qualify on authorized Windows,
  iPhone and Android hardware with camera/thermal/battery permission,
  same workloads and no owner workstation touched by this lane.
