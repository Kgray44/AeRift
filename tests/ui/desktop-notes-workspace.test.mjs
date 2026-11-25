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

test("editing and note actions share the same floating Glass bar above the writing field", () => {
  const shared = read("WorkspaceNoteTools.tsx");
  const notes = read("windows/DesktopNotesWorkspace.tsx");
  assert.match(shared, /className="aw-note-canvas"[^]*<GlassSurface[^>]*aw-note-toolbar[^]*label="Markdown"[^]*\{actions\}[^]*<textarea/);
  assert.match(notes, /<WorkspaceNoteEditor[^]*actions=\{<>[^]*label="Save note"[^]*label="Delete note"/);
});

test("category assignment is an on-demand toolbar control, not a permanent field", () => {
  const notes = read("windows/DesktopNotesWorkspace.tsx");
  assert.doesNotMatch(notes, /aw-note-category-select|<select\b/);
  assert.match(notes, /<WorkspaceNoteEditor[^]*actions=\{<>[^]*<NoteCategoryPicker/);
  assert.match(notes, /label="Move note to category"[^]*aria-expanded=\{open\}/);
});
