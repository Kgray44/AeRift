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

test("bounded release metadata survives deterministic JSON and template round trips", () => {
  const modes = ["unsigned", "signed", "upload", "observe"];
  for (let index = 1; index <= 64; index++) {
    const metadata = {
      candidate: index.toString(16).padStart(40, "0"),
      mode: modes[index % modes.length],
      version: `${index % 10}.${index % 12}.${index}`,
      build: index % 2 ? String(index) : `${index}.99.0`,
    };
    const roundTrip = JSON.parse(JSON.stringify(metadata));
    assert.deepEqual(validateInputs(roundTrip), metadata);
    const projected = renderWorkflow(template, roundTrip);
    assert.equal(projected, renderWorkflow(template, metadata));
    assert.ok(!/__([A-Z_]+)__/.test(projected));
    assert.ok(projected.includes(
      `--mode ${metadata.mode} --candidate ${metadata.candidate} --version ${metadata.version} --build ${metadata.build}`,
    ));
    assert.equal(projected.includes("  unsigned:\n    if: true"), metadata.mode === "unsigned");
    assert.equal(projected.includes("  protected:\n    if: true"), metadata.mode !== "unsigned");
  }
});

test("release metadata rejects ordinary wrong JSON types and out-of-range values without coercion", () => {
  for (const [field, wrongValues] of [
    ["candidate", [[request.candidate], {}, true, null, "", "a".repeat(39), "a".repeat(41)]],
    ["mode", [["unsigned"], {}, true, null, "", "Unsigned"]],
    ["version", [[request.version], {}, 123, null, "0.1", "0.1.0.1"]],
    ["build", [["1"], {}, 1, true, null, "0", "10000", "1.100", "1.2.3.4"]],
  ]) {
    for (const invalid of wrongValues) {
      assert.throws(() => validateInputs({ ...request, [field]: invalid }), /AERIFT_/,
        `reject ${field} with value kind ${typeof invalid}`);
    }
  }
  for (const invalid of [null, undefined, [], "not an object", 12]) {
    assert.throws(() => validateInputs(invalid), /AERIFT_INPUT_INVALID/);
  }
});
