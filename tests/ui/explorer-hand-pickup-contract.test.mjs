import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");

test("Explorer hand pickup Settings is fail-closed and cannot start a camera", () => {
  const settings = read("apps/aerift/src/windows/DesktopSettings.tsx");
  assert.match(settings, /Explorer hand pickup/);
  assert.match(settings, /checked=\{explorerPickup === "enabled"\}/);
  assert.match(settings, /set_explorer_hand_pickup/);
  assert.doesNotMatch(settings, /(?:invoke|command)[^\n]*(?:choose|start)_explorer_camera/);
  const native = read("apps/aerift/src-tauri/src/ambient_runtime.rs");
  assert.match(native, /fn set_explorer_hand_pickup[\s\S]*require_main\(&window\)\?/);
  assert.match(native, /explorer_pickup_enabled: bool/);
});
