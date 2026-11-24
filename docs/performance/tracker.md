# API-1 performance tracker

Reference main: `e8cab6efff8e4f100ff582b2ef7d945de3fcd64e` /
tree `8679c8035439628f777e44468f2ab602df43de95`. A prototype or isolated
fixture below does not imply a merged change, installed-platform result,
or readiness to release.

## First retained baseline

[Raw Linux x64 frontend evidence](baselines/e8cab6ef-linux-frontend.json):
Node 24.22.3, TypeScript 5.9.3, Vite 7.3.8; fresh build processes pinned to
one logical CPU; one warm-up, seven measured serial builds with cached
dependencies. The visible one-minute load average moved from 0.81 to 2.0.
There was no known concurrent project benchmark, but this remains shared
cloud tooling timing, not a platform latency budget.

| Metric | p50 | p95 |
|---|---:|---:|
| TypeScript wall, including process launch | 5.920 s | 6.493 s |
| Vite production wall, including process launch | 2.428 s | 2.659 s |
| Combined tooling wall | 8.332 s | 9.093 s |

All seven output fingerprints and byte counts matched. The static entry
loaded all emitted JS and CSS at this revision: **437,123 bytes JS** raw /
**137,010 bytes** individually gzipped; **121,433 bytes CSS** raw /
**22,554 bytes** individually gzipped. That is **159,564 encoded JS + CSS
bytes** before non-JS/CSS assets. No installed launch, input/frame pacing,
process-tree memory, or energy was measured.

## Workstreams

| ID | Scope and status | Verified evidence and qualification still needed |
|---|---|---|
| **P0** | Performance Observatory: local evidence contract, validator and reproduction entry point | Exact clean baseline above. Windows, iOS and Android device instrumentation remains unavailable. No app sampling or hard timing gate was introduced. |
| **P1** | Runtime Resource Governor: isolated candidate `e5e473d0` | Single 10 s Linux current-thread Tokio fixture per arm: disabled callbacks 40 → 0, voluntary context switches 83 → 5, enabled fallback 39 callbacks. Not a Windows idle, battery, or hardware sleep result; repeat on hosted/real Windows and prove lock/permission handling. |
| **P2** | Glass Engine Optimization: isolated candidate `8fd029ec` | Nine alternating batches of six in cloud Node CPU fixture: workspace median 22.998 → 20.041 ms; mobile-shaped 14.489 → 13.260 ms; Ambient wide 3.204 → 3.206 ms (noise). Four raster/phase comparisons were byte-identical per fixture. No DOM/GPU/frame pacing/device battery evidence; capture actual WebView traces and visual parity before a platform claim. |
| **P3** | Gesture and Camera Optimization: isolated candidate `dc6f9cf` | Controlled pinned Linux model inference and simulated bridge readiness only; no physical client queue dwell, power, or gestures yet. Record source cadence and cold/warm model activation separately. |
| **P4** | Transfer optimization: isolated candidate `2b955f71` | Seven plus seven alternating cached 128 MiB receiver-stage trials on Linux, pinned CPU. Append median 208.613 → 39.094 ms, final rehash/sync 133.192 → 130.291 ms, combined 371.34 → 742.78 MiB/s, process peak RSS 3,196 → 2,236 KiB. No CPU-time sample, TLS/network, source prep, WAN, or desktop claim. Native integrity/cancel/progress and device A/B remain separate gates. |
| **P5** | Startup and bundle: active candidate work, exact initial byte baseline established | Use total emitted vs. static entry closure above to detect true deferral. Measure time to interactive and existing receive readiness on physical Windows/iOS/Android; do not assume compression estimate is launch latency. |
| **P6** | Frontend Rendering Architecture: isolated candidate `0f487b8` | Exact baseline desktop writes serialized settings synchronously on settings changes; mobile startup reads/parses preferences synchronously. Establish React commit count/time, input p95 and subscribe churn before claiming a gain. |
| **P7** | Storage and Media Optimization: source audit only | Exact baseline workspace metadata list uses IndexedDB `getAll()` and decodes all objects with attached Blobs. Measure bounded list and selected-content load under synthetic 1k/10k records; retain integrity and permission tests. |
| **P8** | Networking Optimization: source audit only | Exact baseline Friends route refreshes every 1.5 seconds while active. Measure idle requests/wakeups and discovery/transfer latency; Nearby, Remote and Friends scope and approval must remain independent. |
| **P9** | Cross-Platform Qualification: evidence contract available; installed qualification pending | Use identical scenarios on Windows, iOS and Android plus any Linux tool/reference scenarios that apply. Hosted package, emulator, and actual hardware evidence must remain distinct. No release admission is inferred from P0–P8 microbenchmarks. |

## Wave one candidate

Composition parent: pending integration `94ac741842ef4c8575ed5b8576599915c92125e0`
(tree `4a0c9d1a6e2416d7ff89a932c8fcf4862df09122`). Source measurements were
obtained independently on the original reference above, not at this
composed revision. They do not add together or establish end-to-end gains.

| Slice | Controlled change | Still unmeasured |
|---|---|---|
| P0 observatory | Tooling baseline and evidence validator; no runtime change | Installed startup, input latency, RSS and power |
| P1 idle watchdog | Disabled: 40 → 0 callbacks / 83 → 5 voluntary context switches in one 10 s Linux fixture per arm; enabled fallback retained | Windows session events, actual idle battery, installed lock/exclusion timing |
| P2 Glass optics | CPU rasters: 22.998 → 20.041 ms workspace, 14.489 → 13.260 ms mobile shapes, neutral Ambient; byte-identical output | Actual Windows/iOS/Android compositor and frame pacing |
| P3 camera readiness | Simulated startup callback count 49 → 0; subsequent ready-window callbacks 5 → 5. Separate pinned native Linux model photo 22.88 ms median, blank 12.62 ms; not before/after inference | Physical camera startup, freshness, gesture classification, battery |
| P4 file checkpoints | Pinned 128 MiB synthetic local receiver, append 208.613 → 39.094 ms and final SHA + sync unchanged within trial variability | Physical storage latency, TLS or WAN throughput, parallel transfers |
| P6 spatial peer renders | Six peer tiles over 120 progress commits: 720 → 0 peer-subtree commits; next selection update 6 → 1 | Rendering CPU/GPU, native WebView input, frame pacing |

P5 and P7–P9 are not part of this candidate. Nearby, Remote and Friends
routing, explicit consent, path authority, and folder durable checkpoints
must still qualify on the exact integrated candidate. See the individually
documented comparator, inputs, and limitations before reproducing.

## Admission rules

Before calling an optimization faster, retain both source revisions,
reproducible inputs and environment, per-trial raw numbers, sample counts
and a separate correctness receipt. Use interleaved baseline/candidate
trials whenever possible and preserve quality/authorization checks rather
than relaxing a destination or asset requirement to improve a number.
For each unavailable metric state what instrument, installed build or
physical device is still required. See the [contract and runner](README.md).
