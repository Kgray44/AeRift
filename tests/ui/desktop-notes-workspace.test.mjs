import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = file => readFileSync(new URL(`../../apps/aerift/src/${file}`, import.meta.url), "utf8");
test("desktop Notes uses a dedicated two-pane editor and sidebar instead of the Workspace object grid", () => {
  const desktop = read("windows/DesktopWorkspace.tsx");
  assert.match(desktop, /<DesktopNotesWorkspace\b/);
  assert.doesNotMatch(desktop, /<DesktopNoteEditor\b/);
  const notes = read("windows/DesktopNotesWorkspace.tsx");
  assert.match(notes, /<DesktopNotesSidebar\b/);
  assert.match(notes, /aria-label="Note editor"/);
  assert.match(notes, /sortDesktopNotes\(/);
});
test("formatting and preview are icons with names, not a row of text", () => {
  const shared = read("WorkspaceNoteTools.tsx");
  assert.match(shared, /<NoteIconButton\b/);
  assert.match(shared, /aria-label=\{label\}/);
  assert.match(shared, /<svg\b[^>]*aria-hidden=/s);
  assert.doesNotMatch(shared, />\{label\}<\/Button>/);
});
