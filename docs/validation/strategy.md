# Alpha validation strategy

Use the [v1 protocol](../../contracts/v1/protocol.md) and the [integration acceptance gates](../../tests/README.md) as the source of expected behavior. Qualify each runnable workstream on its exact PR head, then rerun cross-owner scenarios on the integrated SHA. Keep the native [release matrix](alpha-0.1.md) with the candidate evidence.

## Executable checks

Run `node --test "tests/acceptance/*.test.mjs"` with Node 24. Windows and macOS CI run the same dependency-free checks. Foundation CI continues to run Rust and TypeScript contract checks and cross-checks the protocol crate for the iOS simulator. The acceptance tests validate lifecycle assertions and benchmark arithmetic using synthetic fixtures. The lifecycle assertion takes a complete ordered trace for one transfer on one device. Poll snapshots can skip states and are unsuitable input. For captures with both copies locally available, run `node tests/acceptance/hash-file.mjs <source> <received>` to stream both files and assert equal SHA-256 and size.

| Workstream | First runnable check | Integrated handoff |
| --- | --- | --- |
| Windows host | Native build and launch, picker cancellation/denial, capability review | Signed or labeled test installer, actual launch and app bridge evidence |
| iOS host | macOS build, simulator launch where available, permission and file adapter tests | Provisioned physical install, local network and camera denial/recovery, sandbox save and reopen |
| Discovery and pairing | Loopback discovery lifecycle, invite expiry and denial, trusted reconnect and revocation | Two peers: authenticated transport bound to saved identity, discovery recoverable after reconnect |
| Transfer | Production engine on loopback, then separate sender and receiver processes if an entry point exists | Both directions, empty and large files, hashes, duplicates, cancellation and disconnect, approval required |
| GLASS UI | AppPort-driven rendering and component keyboard, focus, roles, contrast, reduced motion and token checks | Actual controls exercise native actions, progress and recovery with assistive technology |
| Gestures | Deterministic timestamps/landmarks and duplicate release, timeout, blur, state and target invalidation | Exactly one real offer per action on both platforms with camera permissions and button fallback |

For loopback, use production APIs with two isolated native stores, temporary roots, ephemeral identities, a listener on a dynamically assigned loopback port, bounded timeouts and deterministic teardown. Swap sender and receiver roles. Capture event stream, terminal states, destination entry count and hashes. Exercise malformed inputs and unauthorized requests through the approved native test interfaces. Include invalid destinations, permission errors and path-boundary rejection through the filesystem adapter. Assert no publication on denial or failure, no overwrite on collision, and no success before remote confirmation. Record unsupported OS semantics where a simulated adapter error substitutes for real permission denial.

## Defensive review gates

These are review targets from the protocol. The foundation does not implement the control paths. Link each review to a PR head, implementation locations and executed evidence.

| Area | Required verification before Alpha |
| --- | --- |
| Authentication and encryption | Pairing requires explicit consent. Connections use TLS 1.3 and certificate possession. Transfers are scoped to the authenticated, persisted identity. Unknown peers cannot write or trigger a published file. |
| Trust and secrets | Windows protects keys with DPAPI-backed storage and iOS uses Keychain. Trust persists after restart. Revocation blocks future requests and stops active local transfers. Invitations expire and stay out of storage, logs, and telemetry. |
| Incoming approval and storage | Offer approval gates any content write. Final output uses a safe native destination, rejects traversal and special names, preserves existing files, verifies digest and length, and serializes publication with cancellation. Review link or reparse-point handling and partial cleanup on both platforms. |
| Resource limits | Enforce bounded control messages, deadlines, connection/offer concurrency and receive quota. Review aggregate reservation across concurrent accepted transfers and terminal record retention. |
| Camera and app permissions | Camera frames and landmark processing stay on device. Confirm capture stops when disabled. Enumerate network and webview capabilities and tie each to the supported flow. Check iOS permission text and Windows firewall scope. |
| Logs and diagnostics | Check pairing, transfer and permission failures for secret material, raw paths, filenames and camera data. Share only redacted output. |

## Performance measurement

Use a dedicated environment label per host, direction, payload, route and configuration. Record SHA, hardware, OS, build mode, link type, payload hash and size, and measurement tool. Run one warm-up, then at least five retained trials per environment label. Keep failed and interrupted runs in the test receipt outside the successful throughput series.

Measure setup from connect request to authenticated usable connection. Time transfer from upload start through receiver publication and sender confirmation. Verify the received hash for every trial. Measure peak resident memory of a named process across the full trial and record how it was sampled. To measure progress overhead, pair equivalent runs with progress enabled and disabled through an instrumented build, alternate order, and use the same phase boundaries. Measure gesture latency from the recognizer input timestamp to emitted intent and UI latency from input to rendered acknowledgment during transfer. Use a monotonic clock for elapsed spans. Record unavailable metrics as omitted with a reason in the receipt notes.

Run `node tests/acceptance/benchmark.mjs receipt.json` to compute nearest-rank p50, p95 and maximum. The JSON input has `commit`, `environment`, `payloadBytes` and `trials`. Each trial has `connectionMs`, `transferMs`, `peakRssBytes` and `integrityVerified`. Optional per-trial fields are `progressOffMs`, `gestureMs` and `uiInputMs`. Supply each optional field in all trials of a series when measured. Throughput uses MiB/s. Negative progress overhead is retained as measured. The analyzer checks and summarizes input. Candidate instrumentation and physical measurements are pending.
