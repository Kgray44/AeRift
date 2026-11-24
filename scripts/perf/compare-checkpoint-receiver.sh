#!/usr/bin/env bash
# Linux-only: one short release build per variant, external scratch only.
set -euo pipefail
BASE="${1:-e8cab6efff8e4f100ff582b2ef7d945de3fcd64e}"
CPU="${2:-7}"
ROOT="$(git rev-parse --show-toplevel)"
SCRATCH="$(mktemp -d "${AERIFT_BENCH_SCRATCH:-${TMPDIR:-/tmp}}/aerift-p4.XXXXXXXX")"
trap 'rm -rf -- "$SCRATCH"' EXIT
mkdir "$SCRATCH/src" "$SCRATCH/data"
cat > "$SCRATCH/Cargo.toml" <<'MANIFEST'
[package]
name = "aerift-p4-local"
version = "0.0.0"
edition = "2024"
[dependencies]
sha2 = "=0.10.9"
tempfile = "=3.27.0"
[lints.rust]
unexpected_cfgs = { level = "warn", check-cfg = ['cfg(aerift_p4_baseline)'] }
MANIFEST
cp "$ROOT/scripts/perf/checkpoint-receiver.rs" "$SCRATCH/src/main.rs"
git -C "$ROOT" show "$BASE:crates/transfer/src/checkpoint.rs" > "$SCRATCH/src/input.rs"
# Selection is a source fixture switch, not a compiler/default-profile change.
sed -i -e 's/cfg(not(aerift_p4_baseline))/cfg(any())/g' -e 's/cfg(aerift_p4_baseline)/cfg(all())/g' "$SCRATCH/src/main.rs"
cargo build --release --manifest-path "$SCRATCH/Cargo.toml"
cp "$SCRATCH/target/release/aerift-p4-local" "$SCRATCH/before"
cp "$ROOT/scripts/perf/checkpoint-receiver.rs" "$SCRATCH/src/main.rs"
cp "$ROOT/crates/transfer/src/checkpoint.rs" "$SCRATCH/src/input.rs"
cargo build --release --manifest-path "$SCRATCH/Cargo.toml"
cp "$SCRATCH/target/release/aerift-p4-local" "$SCRATCH/after"
"$SCRATCH/before" generate "$SCRATCH/data"
rustc -V
grep -m1 'model name' /proc/cpuinfo
df -T "$SCRATCH/data"
cat /proc/loadavg
for label in before after; do taskset -c "$CPU" "$SCRATCH/$label" measure "$SCRATCH/data" >/dev/null; done
for pair in 'before after' 'after before' 'before after' 'after before' 'before after' 'after before' 'before after'; do
  for label in $pair; do
    printf '%s ' "$label"
    taskset -c "$CPU" "$SCRATCH/$label" measure "$SCRATCH/data"
  done
done
cat /proc/loadavg
