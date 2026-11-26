import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../apps/android/emulator-smoke.sh", import.meta.url), "utf8");
const extract = name => {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
  assert.ok(body, `missing production helper ${name}`);
  return body[0];
};

test("a crashed owned emulator fails UI polling immediately without reporting a missing label", {
  skip: process.platform !== "linux",
}, () => {
  const check = spawnSync("bash", ["-c", [
    "set -euo pipefail", extract("assert_emulator_alive"), extract("await_ui"),
    'tmp="$(mktemp -d)"; trap \'rm -rf "$tmp"\' EXIT; gpu=swiftshader',
    'printf "synthetic emulator diagnostic\\n" >"$tmp/emulator.log"',
    "sleep 30 & pid=$!", 'assert_emulator_alive "fixture boot"',
    'kill "$pid"; wait "$pid" 2>/dev/null || true',
    "dump_ui() { echo 'unexpected poll' >&2; return 1; }",
    'await_ui "Choose a file" 12',
  ].join("\n")], { encoding: "utf8", timeout: 3000 });
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stderr, /process stopped during waiting for Choose a file/);
  assert.match(check.stderr, /synthetic emulator diagnostic/);
  assert.doesNotMatch(check.stderr, /unexpected poll|UI did not show/);
});

test("a live emulator still must produce requested UI coordinates", {
  skip: process.platform !== "linux",
}, () => {
  const check = spawnSync("bash", ["-c", [
    "set -euo pipefail", extract("assert_emulator_alive"), extract("await_ui"),
    'gpu=swiftshader; tmp="/unused"; sleep 30 & pid=$!',
    'trap \'kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true\' EXIT',
    "dump_ui() { return 0; }; locate() { printf '10 20\\n'; }",
    'await_ui "Choose a file" 1',
  ].join("\n")], { encoding: "utf8", timeout: 3000 });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout.trim(), "10 20");
});

test("a live emulator without the requested label still fails the assertion", {
  skip: process.platform !== "linux",
}, () => {
  const check = spawnSync("bash", ["-c", [
    "set -euo pipefail", extract("assert_emulator_alive"), extract("await_ui"),
    'gpu=swiftshader; tmp="/unused"; sleep 30 & pid=$!',
    'trap \'kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true\' EXIT',
    "sleep() { :; }; dump_ui() { return 0; }; locate() { return 1; }",
    'await_ui "Choose a file" 1',
  ].join("\n")], { encoding: "utf8", timeout: 3000 });
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stderr, /Android UI did not show: Choose a file/);
  assert.doesNotMatch(check.stderr, /process stopped/);
});
