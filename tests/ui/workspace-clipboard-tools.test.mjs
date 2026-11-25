import assert from "node:assert/strict";
import test from "node:test";
import { browseClipboardEntries, clipboardEntryDetails, writeWorkspaceClipboard } from "../../apps/aerift/src/workspace-clipboard-tools.ts";

const entries = [
  { name: "Pass 20", text: "Mix\nOrange" },
  { name: "Pass 3", text: "Orange", format: "markdown" },
  { name: "Other", text: "Never touched" },
];
const describe = entry => entry;
const options = { query: " PASS orange ", format: "all", order: "saved" };

test("search scans only supplied pins and combines title, body, and filter", () => {
  assert.deepEqual(browseClipboardEntries(entries, describe, options), entries.slice(0, 2));
  assert.deepEqual(browseClipboardEntries(entries, describe, { ...options, format: "multiline" }), [entries[0]]);
  assert.deepEqual(browseClipboardEntries(entries, describe, { ...options, format: "single-line" }), [entries[1]]);
  assert.deepEqual(browseClipboardEntries(entries, describe, { ...options, order: "name" }), [entries[1], entries[0]]);
  assert.equal(entries[0].name, "Pass 20");
});

test("metadata counts runs and CRLF lines without relabeling text format", () => {
  assert.deepEqual(clipboardEntryDetails({ text: "alpha beta\r\ngamma", format: "markdown" }), {
    format: "Markdown", lines: 2, words: 3, characters: 17,
  });
  assert.deepEqual(clipboardEntryDetails({ text: "" }), { format: "Plain text", lines: 0, words: 0, characters: 0 });
});

test("copy never invokes an unavailable or disallowed writer and does not normalize bytes", async () => {
  const writes = [];
  const writer = async text => writes.push(text);
  assert.equal(await writeWorkspaceClipboard("secret", false, writer), "disabled");
  assert.equal(await writeWorkspaceClipboard("secret", true), "unavailable");
  assert.deepEqual(writes, []);
  assert.equal(await writeWorkspaceClipboard(" one\r\ntwo ", true, writer), "copied");
  assert.deepEqual(writes, [" one\r\ntwo "]);
});
test("write rejection reports denied separately from unsupported and other failures", async () => {
  for (const [name, result] of [["NotAllowedError", "denied"], ["SecurityError", "denied"], ["NotSupportedError", "unavailable"], ["TypeError", "failed"]]) {
    assert.equal(await writeWorkspaceClipboard("pin", true, async () => { throw new DOMException("x", name); }), result);
  }
});
