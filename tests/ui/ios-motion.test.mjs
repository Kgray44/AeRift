import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const ios = (file) => readFileSync(new URL("../../apps/aerift/src/ios/" + file, import.meta.url), "utf8");
const load = () => {
  const source = ios("mobile-motion.ts");
  const exports = {};
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports });
  return exports.mobileMotionDirection;
};

test("iOS traversal follows dock or visible module order, not navigation history", () => {
  const direction = load();
  const dock = ["home", "workspace", "rift", "devices", "activity"];
  assert.equal(direction(dock, "home", "rift"), "forward");
  assert.equal(direction(dock, "activity", "workspace"), "back");
  assert.equal(direction(["files", "notes", "collections"], "collections", "notes"), "back");
});

test("initial, invalid and same-destination moves do not create a directional transition", () => {
  const direction = load();
  const dock = ["home", "workspace", "rift"];
  assert.equal(direction(dock, undefined, "home"), undefined);
  assert.equal(direction(dock, "rift", "rift"), undefined);
  assert.equal(direction(dock, "rift", "settings"), undefined);
  assert.equal(direction(dock, "removed", "rift"), undefined);
});

test("only the iOS content gets keyed animation; transfer and dock are persistent", () => {
  const app = ios("IosApp.tsx");
  const workspace = ios("MobileWorkspace.tsx");
  assert.match(app, /key=\{destination\} className="ios-page"[^>]+data-ae-route-enter=\{route\.motion\}/);
  assert.doesNotMatch(app, /<(?:TransferWorkspace|MobileNavigation)\s+key=/);
  assert.match(workspace, /key=\{current\} data-ae-route-enter=\{[^}]+\}/);
  assert.match(workspace, /aria-pressed=\{id === current\}/);
});

test("persistent views mirror their entrance in RTL and opt out for both Reduce Motion settings", () => {
  const css = ios("ios.css");
  assert.match(css, /\.aerift-ios:dir\(rtl\)\[data-ios-route-motion="forward"\]\s*\{\s*--ios-transfer-entry:\s*ae-route-back/);
  assert.match(css, /\[data-motion="reduce"\][^{}]*\.ae-transfer-space[^{}]*\{ animation: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^{}]*\.ae-transfer-space[^{}]*\{ animation: none/);
});

test("immediate route reversals use the live state and do not move the last presented page", () => {
  const app = ios("IosApp.tsx");
  assert.match(app, /setRoute\(current => \{\s+const change = createNavigationChange\(mobileNavigation, current\.destination,/);
  assert.match(app, /motion: mobileMotionDirection\(mobileDestinations, from, change\.to\)/);
  assert.match(app, /if \(settingsOpen \|\| lastFocusedRoute\.current === destination\) return/);
});

test("settled or newly suppressed iOS entries cannot replay after Reduce Motion is turned off", () => {
  const app = ios("IosApp.tsx");
  const workspace = ios("MobileWorkspace.tsx");
  for (const source of [app, workspace]) {
    assert.match(source, /onAnimationEnd=/);
    assert.match(source, /observeMobileMotionSuppression/);
  }
});
