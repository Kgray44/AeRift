import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMobileOperations } from "../../apps/aerift/src/ios/mobile-platform.ts";

const source = path => readFileSync(new URL("../../apps/aerift/src/" + path, import.meta.url), "utf8");
test("both mobile platforms use the shared imported gallery and an explicit native media picker", () => {
  const tray = source("ios/MobileMediaTray.tsx");
  assert.match(tray, /<WorkspacePhotosGallery[\s\S]*?scope=\{copy\.photoAlbumScope\}/);
  assert.match(tray, /onNativeImport=/);
  assert.match(tray, /port\.present\(item\.assetId, "preview"\)/);
  assert.match(tray, /port\.present\(item\.assetId, "export"\)/);
  const gallery = source("WorkspacePhotosGallery.tsx");
  assert.match(gallery, /onNativeImport \? <GlassSurface[\s\S]*?onNativeImport\(\)/);
  assert.match(source("ios/mobile-platform.ts"), /photoAlbumScope: "ios"[\s\S]*?photoAlbumScope: "android"/);
});

for (const platform of ["ios", "android"]) {
  test(platform + " imported asset flow preserves picker and opaque ID authority", async () => {
    const asset = { id: "dc5d6e1c-91ba-4651-8875-0c0fd503b3fa", name: "Rift.jpg", kind: "photo", sizeBytes: 999 };
    const calls = [];
    const success = value => ({ ok: true, value });
    const { media } = createMobileOperations(platform, async (command, args) => {
      calls.push([command, args]);
      if (command.startsWith("list_") || command.startsWith("import_")) return success([asset]);
      if (command.startsWith("remove_")) return success([]);
      return success(null);
    });
    const result = await media.import("photos");
    const id = result.value[0].assetId;
    assert.equal(id, asset.id);
    assert.equal((await media.list()).value[0].assetId, id);
    await media.present(id, "preview");
    await media.present(id, "export");
    await media.select(id);
    assert.equal((await media.remove(id)).value.length, 0);
    assert.deepEqual(calls, [
      [`import_${platform}_media`, { source: "photos" }],
      [`list_${platform}_media`, undefined],
      [`present_${platform}_media`, { assetId: id, action: "preview" }],
      [`present_${platform}_media`, { assetId: id, action: "export" }],
      [`select_${platform}_media`, { assetId: id }],
      [`remove_${platform}_media`, { assetId: id }],
    ]);
  });
}
