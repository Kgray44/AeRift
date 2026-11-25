import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL("../../apps/aerift/src/" + path, import.meta.url), "utf8");

test("desktop Documents opens the document grid over persisted, filtered blob references", () => {
  const source = read("windows/DesktopWorkspace.tsx");
  assert.match(source, /section\?\.id === "documents" && <WorkspaceDocumentsGallery/);
  assert.match(source, /readAsset=\{loadWorkspaceAsset\}/);
});
test("mobile Documents uses platform-scoped imports, actual viewer and existing Rift selection", () => {
  const workspace = read("ios/MobileWorkspace.tsx");
  const adapter = read("ios/MobileDocumentsGallery.tsx");
  assert.match(workspace, /documents && <MobileDocumentsGallery[^>]*port=\{media\}/s);
  assert.match(adapter, /port\.import\("files"\)/);
  assert.match(adapter, /port\.present\(row\.id, "preview"\)/);
  assert.match(adapter, /port\.select\(row\.id\)/);
});
