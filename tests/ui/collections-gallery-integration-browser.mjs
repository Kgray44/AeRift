import assert from "node:assert/strict";

const button = (scope, name) => scope.getByRole("button", { name, exact: typeof name === "string" });
const base = id => ({ id, schemaVersion: 1, ownership: "local" });
const legacy = [
  { ...base("legacy-collection"), kind: "collection", name: "Saved collection from prior version", itemIds: ["legacy-pin"] },
  { ...base("legacy-pin"), kind: "text", name: "Private pinned test", text: "Synthetic private clipboard marker", format: "plain" },
];

export async function verifyCollectionsGallery(browser, root) {
  const desktop = await browser.newPage({ viewport: { width: 1150, height: 840 } });
  await desktop.goto(root + "/desktop-visual.html?route=workspace");
  await button(desktop, "File Browser").click();
  await desktop.locator('input[type="file"][aria-label="Import files"]').setInputFiles([
    { name: "Collection sample.txt", mimeType: "text/plain", buffer: Buffer.from("fixture only") },
  ]);
  await desktop.getByRole("checkbox", { name: "Collection sample.txt" }).check();
  await button(desktop, "Back to Workspace").click();
  await button(desktop, "Collections").click();
  const gallery = desktop.getByRole("region", { name: "Collections workspace" });
  await button(gallery, "New collection").click();
  await gallery.getByRole("textbox", { name: "Collection name" }).fill("Desktop grouped documents");
  await gallery.getByRole("checkbox", { name: "Add 1 selected items" }).check();
  await button(gallery, "Create collection").click();
  await button(gallery, "Remove Collection sample.txt from collection").waitFor();
  await button(gallery, "Back to collections").click();
  await button(gallery, "Recents").click();
  await button(gallery, /Desktop grouped documents/).waitFor();
  await desktop.reload();
  await button(desktop, "Collections").click();
  await button(gallery, /Desktop grouped documents/).click();
  await button(gallery, "Remove Collection sample.txt from collection").waitFor();
  await desktop.close();

  for (const platform of ["ios", "android"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 840 }, isMobile: true, hasTouch: true });
    await page.addInitScript(({ platform, legacy }) => {
      const key = `aerift.${platform}.objects.v1`;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(legacy));
      window.collectionCalls = [];
      window.__TAURI_INTERNALS__ = { async invoke(name, payload) {
        if (name === `stage_${platform}_text`) {
          window.collectionCalls.push(payload);
          return { selectionId: "test-collection-selection", name: payload.name, sizeBytes: 100 };
        }
        return null;
      } };
    }, { platform, legacy });
    await page.goto(root + "/mobile.html?platform=" + platform);
    const dock = page.getByRole("navigation", { name: "AeRift destinations" });
    await button(dock, "Workspace").click();
    await button(page, "Collections").click();
    const mobile = page.getByRole("region", { name: "Collections workspace" });
    await button(mobile, /Saved collection from prior version/).click();
    const send = button(mobile, "Send collection copy to Rift");
    assert.equal(await send.isDisabled(), true, "saved clipboard members do not bypass sharing settings");
    assert.equal(await page.getByText("Synthetic private clipboard marker", { exact: true }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.collectionCalls), []);
    await button(page, "Control Center").click();
    const settings = page.getByRole("dialog", { name: "Control Center" });
    await settings.getByRole("checkbox", { name: "Clipboard", exact: true }).check();
    await settings.getByRole("checkbox", { name: "Allow sending clipboard copies through Rift" }).check();
    await button(settings, "Close").click();
    await send.click();
    await page.waitForFunction(() => window.collectionCalls.length === 1);
    const [payload] = await page.evaluate(() => window.collectionCalls);
    assert.match(payload.text, /Synthetic private clipboard marker/);
    assert.match(payload.text, /legacy-collection/);
    await dock.getByRole("button", { name: "Rift", exact: true }).and(dock.locator('[aria-current="page"]')).waitFor();
    await page.close();
  }
}
