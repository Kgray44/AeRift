import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderWorkflow, validateInputs } from "../../scripts/testflight/dispatch.mjs";

const template = readFileSync(new URL("../../.agents/aerift-testflight-hosted.yml", import.meta.url), "utf8");
const request = { candidate: "a".repeat(40), mode: "unsigned", version: "0.1.0", build: "1" };

test("unsigned mode pins the source and disables the protected job", () => {
  const workflow = renderWorkflow(template, request);
  assert.equal(workflow.match(new RegExp(request.candidate, "g")).length, 7);
  assert.match(workflow, /  unsigned:\n    if: true/);
  assert.match(workflow, /  protected:\n    if: false\n    environment: aerift-testflight/);
});

test("Windows checkout line endings render the same workflow", () => {
  const lf = template.replaceAll("\r\n", "\n");
  const crlf = lf.replaceAll("\n", "\r\n");
  assert.equal(renderWorkflow(crlf, request), renderWorkflow(lf, request));
});

test("signed validation and upload are distinct protected modes", () => {
  for (const mode of ["signed", "upload", "observe"]) {
    const workflow = renderWorkflow(template, { ...request, mode });
    assert.match(workflow, /  unsigned:\n    if: false/);
    assert.match(workflow, /  protected:\n    if: true\n    environment: aerift-testflight/);
    assert.ok(workflow.includes(`--mode ${mode} --candidate ${request.candidate}`));
  }
});

test("rejects values that cannot safely enter a workflow command", () => {
  for (const invalid of [
    { candidate: "main" }, { mode: "upload --invalid" },
    { version: "0.1.0\n" }, { build: "01" }, { build: "1;touch file" },
  ]) {
    assert.throws(() => validateInputs({ ...request, ...invalid }), /AERIFT_/);
  }
});
