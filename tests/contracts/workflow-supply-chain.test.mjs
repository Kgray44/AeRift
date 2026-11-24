import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/** Deliberately checks the repository's simple block-style workflow policy.
 * This is a regression guard, not a general YAML parser or Actions sandbox. */
function verifyWorkflow(source, name) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const code = lines.filter(line => !/^\s*#/.test(line));
  const permission = code.filter(line => /(?:^|[\s{,])["']?permissions["']?\s*:/.test(line));
  assert.deepEqual(permission, ["permissions:"], `${name}: one explicit read-only permission block, no overrides`);
  const start = code.indexOf("permissions:") + 1;
  const entries = [];
  for (const line of code.slice(start)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) break;
    entries.push(line.trim().replace(/\s+#.*$/, ""));
  }
  assert.deepEqual(entries, ["contents: read"], `${name}: only contents: read`);
  assert.ok(!code.some(line => /\b(?:pull_request_target|workflow_run)\b/.test(line)),
    `${name}: privileged triggers require explicit security review`);

  for (const [index, line] of code.entries()) {
    if (!/(?:^|[\s{,])["']?uses["']?\s*:/.test(line)) continue;
    const use = /^(\s*)(?:- )?uses:\s+([\w.-]+(?:\/[\w.-]+)+)@([a-f0-9]{40})(?:\s+#.*)?\s*$/.exec(line);
    assert.ok(use, `${name}:${index + 1}: require an immutable Action SHA in block style`);
    if (use[2] !== "actions/checkout") continue;
    const optionFloor = use[1].length - (line.trimStart().startsWith("- ") ? 0 : 2);
    const options = [];
    for (const entry of code.slice(index + 1)) {
      if (!entry.trim()) continue;
      if (entry.search(/\S/) <= optionFloor) break;
      options.push(entry.trim().replace(/\s+#.*$/, ""));
    }
    assert.equal(options.filter(line => /^persist-credentials\s*:/.test(line)).join("\n"),
      "persist-credentials: false", `${name}:${index + 1}: checkout must not persist credentials`);
  }
}

test("release and PR workflows remain read-only and immutably pinned", () => {
  const directory = new URL("../../.github/workflows/", import.meta.url);
  const files = readdirSync(directory).filter(file => /\.ya?ml$/.test(file)).sort();
  assert.ok(files.length > 0, "no workflows found");
  for (const file of files) verifyWorkflow(readFileSync(new URL(file, directory), "utf8"), file);
  const template = new URL("../../.agents/aerift-testflight-hosted.yml", import.meta.url);
  verifyWorkflow(readFileSync(template, "utf8"), "TestFlight template");
});

test("supply-chain guard rejects mutable actions, token escalation, and credentials drift", () => {
  const valid = `on: [pull_request]
permissions:
  contents: read
jobs:

 inspect:
    steps:
      - uses: actions/checkout@0123456789012345678901234567890123456789
        with:
          persist-credentials: false
      - run: echo friendly
`;
  verifyWorkflow(valid, "fixture");
  for (const unsafe of [
    valid.replace(/@\w+/, "@v6"),
    valid.replace("contents: read", "contents: write"),
    valid.replace("steps:", "permissions: write-all\n    steps:"),
    valid.replace("persist-credentials: false", "persist-credentials: true"),
    valid.replace("          persist-credentials: false\n", ""),
    valid.replace("pull_request", "pull_request_target"),
    valid.replace(/- uses:.*\n/, "- {uses: actions/checkout@v6}\n"),
  ]) assert.throws(() => verifyWorkflow(unsafe, "fixture"));
});
