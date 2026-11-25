import assert from "node:assert/strict";
import test from "node:test";
import { insertNoteMarkup, matchesWorkspaceNote, noteInlineParts, notePreviewLines, noteWordCount } from "../../apps/aerift/src/workspace-note-tools.ts";

test("note search matches title and body terms without mixing formats", () => {
  const note = { name: "Trip budget", text: "Reserve for fuel", format: "markdown" };
  assert.equal(matchesWorkspaceNote(note, { query: "BUDGET fuel ", format: "any" }), true);
  assert.equal(matchesWorkspaceNote(note, { query: "budget fuel", format: "plain" }), false);
  assert.equal(matchesWorkspaceNote(note, { query: "budget train", format: "any" }), false);
});
test("formatting wraps the selection and inserts a heading at the current line", () => {
  assert.deepEqual(insertNoteMarkup("Say hello", 4, 9, "bold"), { value: "Say **hello**", start: 6, end: 11 });
  assert.deepEqual(insertNoteMarkup("Intro\nBody", 8, 8, "heading"), { value: "Intro\n## Body", start: 11, end: 11 });
  assert.deepEqual(insertNoteMarkup("", 0, 0, "task"), { value: "- [ ] ", start: 6, end: 6 });
});
test("markdown preview represents markup as text, not HTML or active links", () => {
  assert.deepEqual(notePreviewLines("## Heading\n- [x] done\n<script>x</script>\n[click](javascript:alert(1))", true), [
    { kind: "heading", text: "Heading" }, { kind: "done", text: "done" },
    { kind: "text", text: "<script>x</script>" }, { kind: "text", text: "[click](javascript:alert(1))" },
  ]);
  assert.deepEqual(notePreviewLines("## Literal", false), [{ kind: "text", text: "## Literal" }]);
  assert.equal(noteWordCount("  one\n two  "), 2);
});
test("inline formatting has only inert text spans", () => {
  assert.deepEqual(noteInlineParts("A **bold** _slant_ `code` <b>x</b>"), [
    { kind: "text", text: "A " }, { kind: "bold", text: "bold" },
    { kind: "text", text: " " }, { kind: "italic", text: "slant" },
    { kind: "text", text: " " }, { kind: "code", text: "code" }, { kind: "text", text: " <b>x</b>" },
  ]);
});
