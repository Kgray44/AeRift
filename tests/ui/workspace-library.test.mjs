import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
const read = name => readFileSync(new URL(`../../apps/aerift/src/${name}`, import.meta.url), "utf8");
test("both platform Workspaces start at the shared library with a back action", () => {
  for (const file of ["windows/DesktopWorkspace.tsx", "ios/MobileWorkspace.tsx"]) {
    const body = read(file);
    assert.match(body, /<WorkspaceLibrary\b/);
    assert.match(body, /<WorkspaceCategoryHeading\b/);
    assert.match(body, /onBack=\{/);
  }
});
test("documents are an explicit safe filename/media view, not an arbitrary launcher", async () => {
  const source = ts.transpileModule(read("workspace-categories.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const { isWorkspaceDocument, workspaceSections } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.equal(isWorkspaceDocument("Navigation chart.PDF"), true);
  assert.equal(isWorkspaceDocument("Provider object", "application/pdf"), true);
  assert.equal(isWorkspaceDocument("Route.pptx.exe"), false);
  assert.equal(isWorkspaceDocument("photo.jpg", "image/jpeg"), false);
  assert.equal(isWorkspaceDocument("binary.exe", "text/plain"), false);
  assert.equal(workspaceSections.filter(s => s.module === "files").some(s => s.id === "documents"), true);
});
test("mobile dock has a single non-interactive traveling lens and keeps keyed tab buttons", () => {
  const nav = read("ios/MobileNavigation.tsx");
  assert.match(nav, /<MobileDockMotion/);
  const motion = readFileSync(new URL("../../packages/ui/src/MobileDockMotion.tsx", import.meta.url), "utf8");
  assert.match(motion, /className="af-dock-fluid" aria-hidden="true"/);
  assert.match(nav, /destinations\.map\(item => <Button key=\{item\}/);
  const css = read("ios/ios.css");
  assert.match(css, /\.af-dock-fluid[^{}]*\{[^}]*--af-dock-offset/);
  assert.doesNotMatch(css, /\.af-dock-fluid[^{}]*\{[^}]*transition:/);
});
