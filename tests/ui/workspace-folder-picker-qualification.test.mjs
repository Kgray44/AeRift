import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const read = (path) => readFileSync(new URL("../../" + path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const picker = read("apps/aerift/src-tauri/src/workspace_folder_picker.rs");
const shell = read("apps/aerift/src/windows/DesktopApp.tsx");
const host = read("apps/aerift/src-tauri/src/lib.rs");
const desktop = read("apps/aerift/src/windows/DesktopWorkspace.tsx");
const view = read("apps/aerift/src/windows/WorkspaceChosenFolder.tsx");

test("ordinary Windows builder binds a single local owner and three narrow commands", () => {
  const builder = host.split("#[cfg(windows)]\n    let builder")[1];
  assert.ok(builder);
  assert.deepEqual([...builder.matchAll(/workspace_folder_picker::(workspace_\w+)/g)].map(m => m[1]), [
    "workspace_choose_folder", "workspace_list_chosen_folder", "workspace_close_chosen_folder",
  ]);
  assert.match(builder, /get_webview_window\("main"\)[\s\S]*\.bind_owner\(&main\)/);
  assert.match(picker, /window\.label\(\) != "main" \|\| !window\.url\(\)\.is_ok_and/);
  assert.match(picker, /GetGUIThreadInfo\(0, &mut gui\)[\s\S]*IsChild\(parent, child\)[\s\S]*GetForegroundWindow\(\) == owner/);
  assert.match(picker, /owner == foreground[\s\S]*owner == focus \|\| is_child\(owner, focus\)/);
  assert.match(picker, /let inner = bound_state\(&window\)[\s\S]*require_native_focus\(&window\)\?[\s\S]*require_native_focus\(&window\)\?[\s\S]*blocking_pick_folder/);
  assert.match(picker, /WindowEvent::Destroyed/);
  assert.match(picker, /WindowEvent::CloseRequested \{ \.\. \} => \{\s*inner\.revoke_all\(\)/);
});

test("choose, page and close accept only opaque request, grant and cursor tokens", () => {
  assert.match(picker, /workspace_choose_folder\(\s*window: WebviewWindow,\s*request: Uuid,\s*\)/);
  assert.match(picker, /workspace_list_chosen_folder\(\s*window: WebviewWindow,\s*grant: Uuid,\s*cursor: Uuid,\s*\)/);
  assert.match(picker, /workspace_close_chosen_folder\(\s*window: WebviewWindow,\s*request: Uuid,\s*\)/);
  assert.match(picker, /blocking_pick_folder\(\)[\s\S]*from_native_selection\(&path\)/);
  assert.match(picker, /lifecycle\.pending != Some\(request\)/);
  assert.match(picker, /sleep_until\(deadline\.into\(\)\)/);
});

test("the native Files route opens only on click and does not persist or import metadata", () => {
  assert.match(shell, /<DesktopWorkspace[^>]*active=\{route === "workspace"\}/);
  assert.match(desktop, /active && section\?\.id === "files" && isTauri\(\) && <WorkspaceChosenFolder/);
  assert.match(view, /onClick=\{\(\) => void choose\(\)\}/);
  assert.match(view, /if \(!mounted\.current \|\| pending\.current !== request\) \{\s*close\(request\)/);
  assert.match(view, /if \(pending\.current\) close\(pending\.current\);\s*if \(active\.current\) close\(active\.current\)/);
  assert.match(view, /<bdi>\{entry\.name\}<\/bdi>/);
  assert.doesNotMatch(view, /localStorage|indexedDB|dangerouslySetInnerHTML|importFiles|send_file/);
});

test("the chooser retains bounded failure categories without rendering raw platform errors", () => {
  assert.match(view, /invoke<Grant \| null>\("workspace_choose_folder", \{ request \}\)/);
  assert.match(view, /default:\s*return "bridge"/);
  assert.match(view, /data-folder-error=\{error\}\>\{failureMessage\[error\]\}/);
});
