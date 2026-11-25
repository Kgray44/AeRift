import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const src = name => readFileSync(new URL(`../../apps/aerift/src/${name}`, import.meta.url), "utf8");

test("real desktop and mobile workspace markup share the stationary destination and expanding Glass bed", () => {
  assert.match(src("windows/DesktopWorkspace.tsx"), /<WorkspaceScene scene=\{workspace\}/);
  assert.match(src("ios/MobileWorkspace.tsx"), /<WorkspaceScene scene=\{workspace\}/);
  const ws = src("WorkspaceLibrary.tsx");
  assert.match(ws, /heading\.current\?\.focus\(\)/);
  assert.match(ws, /target\?\.focus\(\)/);
  assert.doesNotMatch(ws, /layoutId=|AnimatePresence/);
  const motion = readFileSync(new URL("../../packages/ui/src/WorkspacePanelMotion.tsx", import.meta.url), "utf8");
  assert.match(motion, /aria-hidden="true"/);
  assert.match(motion, /animate=\{to\}/);
  const css = readFileSync(new URL("../../packages/ui/src/workspace-panel-motion.css", import.meta.url), "utf8");
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(css, /(?:backdrop-)?filter:/);
});

test("panel geometry is measured once per real transition and shortens back to the selected card", () => {
  const ws = src("WorkspaceLibrary.tsx");
  assert.match(ws, /workspacePanelBox\(cards\.current\.get\(id\)\?\.closest\("\.aw-card"\)/);
  assert.match(ws, /to: destination/);
  assert.match(ws, /request.direction === "back"/);
  assert.match(ws, /if \(quiet\) setHandoff\(undefined\)/);
  assert.doesNotMatch(ws, /setTimeout|requestAnimationFrame/);
});
