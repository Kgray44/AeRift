import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { distribution } from "./benchmark.mjs";

export function summarizeUiTiming(receipt) {
  const { commit, platform, environment, action, capture, observationMs, idle, streaming } = receipt;
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "record the full candidate SHA");
  assert.ok(["windows", "ios"].includes(platform), "record the native platform");
  for (const [name, value] of Object.entries({ environment, action, capture })) {
    assert.ok(typeof value === "string" && value.trim(), `record ${name}`);
  }
  assert.ok(Number.isFinite(observationMs) && observationMs > 0, "invalid observation window");

  function summarizePhase(samples) {
    assert.ok(Array.isArray(samples) && samples.length >= 5, "record at least five actions per phase");
    const elapsed = [];
    for (const { inputMs, responseMs, observedThroughMs } of samples) {
      assert.ok(Number.isFinite(inputMs) && inputMs >= 0, "invalid input timestamp");
      assert.ok(Number.isFinite(observedThroughMs) && observedThroughMs >= inputMs,
        "invalid end of observation");
      if (responseMs === null) {
        assert.ok(observedThroughMs - inputMs >= observationMs, "incomplete missed-action observation");
        continue;
      }
      assert.ok(Number.isFinite(responseMs) && responseMs >= inputMs &&
        responseMs <= observedThroughMs, "render timestamp outside the observed interval");
      const duration = responseMs - inputMs;
      assert.ok(duration <= observationMs, "render timestamp outside the response window");
      elapsed.push(duration);
    }
    return {
      attempted: samples.length,
      missed: samples.length - elapsed.length,
      inputToRenderMs: elapsed.length ? distribution(elapsed) : null,
    };
  }

  return {
    commit, platform, environment, action, capture, observationMs,
    idle: summarizePhase(idle),
    streaming: summarizePhase(streaming),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "usage: node ui-timing.mjs <measured-ui-receipt.json>");
  const receipt = JSON.parse(await readFile(process.argv[2], "utf8"));
  console.log(JSON.stringify(summarizeUiTiming(receipt), null, 2));
}
