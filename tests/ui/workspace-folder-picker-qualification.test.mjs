import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const read = (path) => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const picker = read("apps/aerift/src-tauri/src/workspace_folder_picker.rs");
const desktop = read("apps/aerift/src-tauri/src/lib.rs");

test("production host does not register the qualification commands", () => {
  assert.match(desktop, /cfg\(all\(windows, feature = "workspace-folder-picker-qualification"\)\)/);
  assert.doesNotMatch(desktop, /workspace_folder_picker::workspace_/);
});

test("chooser IPC does not accept a path, cursor IPC takes only opaque tokens", () => {
  assert.match(picker, /workspace_choose_folder\(\s*window: WebviewWindow,\s*\)/);
  assert.match(picker, /workspace_list_chosen_folder\(\s*window: WebviewWindow,\s*grant: Uuid,\s*cursor: Uuid,\s*\)/);
  assert.match(picker, /workspace_close_chosen_folder\(\s*window: WebviewWindow,\s*grant: Uuid,\s*\)/);
});
