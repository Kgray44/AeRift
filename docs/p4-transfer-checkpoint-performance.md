# P4: avoid redundant receive checkpoint work

Baseline `e8cab6efff8e4f100ff582b2ef7d945de3fcd64e`. The authenticated, length-checked HTTP body was copied from its existing bounded buffer into a second Vec and SHA-256 hashed twice by the process-local v2 receiver: first to generate an expected digest from those same bytes, and then to compare against it. This did not compare against a separate expected digest from the peer. `append_block` borrows the already-buffered bytes. For a forward write, rollback, checked range, consent, backpressure, peer trust and final disk-byte SHA-256/sync remain unchanged. From a retry below the acknowledged prefix, the stored range is still compared with this request's digest and must match; no bytes are advanced or rewritten. The opt-in Unix crash journal remains untouched.

## Same-machine checkpoint microbenchmark

Run `AERIFT_BENCH_SCRATCH=/path/to/local/ext4 bash scripts/perf/compare-checkpoint-receiver.sh <baseline-ref> <linux-cpu>`. Use an otherwise idle machine with at least 350 MiB scratch. The shell harness creates a temporary synthetic source and cleans it up upon exit.

Seven paired samples in alternating AB/BA order, one warm-up per variant. 128 MiB deterministic nonzero-pattern source, 128 x 1 MiB exact reads, same ext4 data/same volume for every temporary receiver stage. Read and hash the source outside timing to supply the true manifest digest, rewind, write every checkpoint, then measure real full verification and fsync separately. Release Rust 1.100.0; AMD EPYC 9V74; worker pinned to logical CPU 7; one benchmark process at a time; pre/post one-minute host load average 0.54/0.69. RSS is process VmHWM. No WAN, TLS, UI or cold-storage claims.

| Metric | Baseline median (range) | Patch median (range) |
|---|---:|---:|
| Append wall time | 208.613 ms (200.936–475.912) | 39.094 ms (31.683–88.602) |
| Final disk rehash and sync | 133.192 ms (127.193–176.643) | 130.291 ms (126.439–193.716) |
| Effective append + finish | 371.34 MiB/s (202.56–389.52) | 742.78 MiB/s (565.76–803.52) |
| Peak RSS | 3,196 KiB (3,196–3,200) | 2,236 KiB (2,232–2,240) |

Measured medians establish a receiver-stage improvement on this machine, not a prediction of 2× network throughput. The path still holds the first bounded HTTP body and sender-side chunk allocation.

## Remaining cost centers and next measurements

1. **Preparation:** Ordinary sender preparation reads the file in bounded chunks to derive the advertised SHA before consent; playback has to read it again. Reuse hashes only when tied to the same native handle/content identity and mutation is detected; do not move expensive reads into asynchronous request execution. Compare prepare wall time, storage read accounting and cancellation latency on cold and warm reads. Frozen captures also verify source blocks to prevent post-capture substitution.
2. **TLS and chunk pacing:** Existing v2 may create separate HTTP/TLS connections for control and each checkpoint. For high RTT, handshake and per-block ACK can dominate this now-cheaper receiver. Measure pinned mutual TLS loopback, then authorized separate networks with the same exact endpoint and attempt counters; measure connections, first-byte latency, retransmission, final receipt, link utilization and process RSS. No fallback or relaxed certificate/consent rules. Keeping a connection open may yield more than optimizing SHA helpers, but needs a dedicated fail-closed transport change.
3. **Buffering:** Existing sender allocates a bounded 1 MiB chunk and HTTP receiver collects a bounded 1 MiB body. Instrument allocation and backpressure at workload with 1/4/16 offers before considering pooling; any retained buffers require an explicit global cap, cancellation releases and memory-in-use tests. Do not raise chunk limits just for loopback results.
4. **Durability:** Journaled upload synchronizes data and persisted checkpoints before advancing, and validates checkpoint bytes at recovery. Do not batch away these syncs under the same acknowledged semantics. If profiling identifies this as the next limit, measure separate time-in-data-sync, metadata replacement and directory sync. A changed ACK durability contract would be a separate versioned decision; not an optimization in this patch.
5. **Publication:** Preserve integrity rehash at completion where the checkpoint engine accepts a staged file, native no-replace publication, incoming acceptance, local-trust separation and revoked-route rejection.
