# AeRift performance observatory

This is an opt-in development and qualification tool, not app telemetry.
There is no background sampler, analytics upload, camera activation or
native-installed client requirement. Results describe the named scenario
and actual execution environment, not every platform that ships the app.

## Reproduce the frontend tooling and asset baseline

From an AeRift worktree with the observatory script checked out, use a clean
candidate worktree that has already installed the locked npm dependencies:

```sh
npm ci
node --test scripts/perf/observatory.test.mjs
node scripts/perf/frontend.mjs . 7 "local workstation, description of load and CPU policy" > /tmp/aerift-frontend.json
node scripts/perf/evidence.mjs /tmp/aerift-frontend.json
```

On Windows PowerShell, redirect to a temporary path of your choosing (use
UTF-8 with no BOM if the shell version defaults to UTF-16).
Pass another checkout instead of `.` to measure a historical clean revision
with locked dependencies installed there. The runner checks commit/tree
and clean status, starts separate Node processes for TypeScript and Vite,
discards one warm-up, measures 5–20 serial trials, and cleans only its own
temporary outputs. It does not install deps or run the native model staging
prebuild hook. Distinct package caches, native assets and build conditions
must be recorded separately before comparing platforms. Use a quiet host;
Linux CPU affinity can be set outside the runner, and should be noted in
the environment description. Timing includes child process launch but
excludes artifact enumeration, checksum and test assertions.

Initial JS and CSS follow only static imports reachable from `index.html`
in the Vite manifest. Dynamic route/vendor chunks are included in total
emitted JS/CSS, not in the initial closure. Encoded bytes are the sum of
each asset gzipped independently at level 6, not a network-transfer trace
or a promise of Tauri startup savings. Other output (e.g. HTML/public
assets) is counted separately without the instrumentation-only manifest.
Content fingerprints cover normalized filenames and content hashes, not
times or absolute paths. A deterministic artifact metric has identical
bytes in each measured trial; a differing output fingerprint calls for
inspection before claiming a stable bundle.

## Evidence contract: `aerift.performance/v1`

Each JSON receipt includes:

- `capturedAt` in UTC, exact `source.commit` and `source.tree` SHA and
  `source.clean`; always carry the exact revision, even for proposed branches.
- `environment.platform`, `arch` and `context`, with useful extras like
  toolchain, hardware/power or runner conditions and contention notes.
- `scenario.id`, `profile` and `conditions`: state, configuration, inputs,
  sample window, warm-up and exclusions. A synthetic fixture and a real
  device run are distinct scenarios even if they use one metric ID.
- Unique `metrics` with `id`, `unit`, `direction` and `status`. Measured
  metrics retain raw `samples` and a verified `summary` (`min`, `count`,
  nearest-rank `p50`, nearest-rank `p95`, `max`). Unavailable metrics
  have a plain `reason` and no numeric samples. Do not substitute zero.
  To measure a signed delta, preserve each variant’s nonnegative timings
  as parallel series and calculate the delta in the report. With seven
  samples the nearest-rank p95 is the maximum, not a stable population
  estimate.

Share artifacts without hostnames, account details, personal paths,
payloads, device IDs, secrets, camera images, or landmarks. Compare the
same scenario and configuration on the same platform and same hardware
class; prefer interleaved A/B trials with cold/warm separated. Treat
uncontrolled shared-cloud latency or unimplemented hardware instruments
as observation only, never a platform budget or a merge failure.

Existing [peer transfer benchmark](../../tests/acceptance/benchmark.mjs)
and [Windows peer trial driver](../../tests/acceptance/run-windows-peer-benchmark.ps1)
remain the authoritative integrity-aware collectors for transfer trials.
The v1 observatory reuses their percentile method; it does not supersede
their payload verification, peak working-set, or raw receipts. Existing
receipts can be normalized to this schema as each track establishes the
same source and environment provenance. Keep their original raw output.

See the [API-1 tracker](tracker.md) for the verified and missing evidence.
