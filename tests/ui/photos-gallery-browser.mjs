import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const location = process.env.AERIFT_PLAYWRIGHT_MODULE;
const { chromium } = await import(location ? pathToFileURL(location).href : "playwright");
const root = process.env.AERIFT_FIXTURE_URL ?? "http://127.0.0.1:4175";
const evidence = process.env.AERIFT_WORKSPACE_EVIDENCE;
const image = Buffer.from("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", "base64");
const browser = await chromium.launch();
const button = (root, name) => root.getByRole("button", { name, exact: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  await page.goto(root + "/desktop-visual.html?route=workspace&scheme=dark");
  await button(page, "Images & Videos").click();
  const gallery = page.getByRole("region", { name: "Photo gallery", exact: true });
  const albums = page.getByRole("complementary", { name: "Photo albums", exact: true });
  await gallery.getByText("No photos here yet.", { exact: false }).waitFor();
  await gallery.locator('input[type="file"]').setInputFiles([
    { name: "Harbor.png", mimeType: "image/png", buffer: image },
    { name: "Forest.png", mimeType: "image/png", buffer: image },
  ]);
  const harbor = button(gallery, "Open Harbor.png");
  await harbor.waitFor();
  const thumb = harbor.locator("img");
  await thumb.waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Open Harbor.png"] img')?.naturalWidth === 64);
  assert.equal(await gallery.locator(".aw-photos-grid li").count(), 2);
  assert.notEqual(await gallery.locator(".aw-photos-grid").evaluate(el => getComputedStyle(el).gridTemplateColumns), "none");
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "desktop-photos-recents.png"), animations: "disabled" });
  }

  await button(albums, "New album").click();
  await albums.getByRole("textbox", { name: "Album name" }).fill("Landscapes");
  await button(albums, "Mint color").click();
  await button(albums, "Heart icon").click();
  await button(albums, "Save album").click();
  const album = button(albums, "Landscapes");
  await album.waitFor();
  assert.equal(await album.locator("svg").getAttribute("data-category-color"), "mint");
  await button(albums, "Recents").click();
  await harbor.click();
  const viewer = page.getByRole("dialog", { name: "Viewing Harbor.png" });
  await viewer.getByRole("link", { name: "Save a copy" }).waitFor();
  await button(viewer, "Add to album").click();
  await button(viewer, "Landscapes").click();
  await button(viewer, "Close photo").click();
  await album.click();
  assert.equal(await gallery.locator(".aw-photos-grid li").count(), 1);
  await harbor.waitFor();

  await page.reload();
  await button(page, "Images & Videos").click();
  await album.click();
  await harbor.waitFor();
  await button(albums, "Remove album").click();
  await button(albums, "Confirm remove album").click();
  assert.equal(await gallery.locator(".aw-photos-grid li").count(), 2, "removing the album does not remove media");
  for (const platform of ["ios", "android"]) {
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 },
      isMobile: true, hasTouch: true, colorScheme: platform === "ios" ? "light" : "dark" });
    await mobile.goto(root + "/mobile.html?platform=" + platform + "&photoGalleryFixture=1");
    await button(mobile, "Workspace").tap();
    await button(mobile, "Images & Videos").tap();
    const photos = mobile.getByRole("region", { name: "Photo gallery" });
    const albumBar = mobile.getByRole("complementary", { name: "Photo albums" });
    assert.equal(await photos.locator('input[type="file"]').count(), 0, "mobile cannot invoke DOM imports");
    await button(photos, "Import photos and videos").tap();
    const harbor = button(photos, "Open Harbor aerial.heic");
    const video = button(photos, "Open Harbor approach.mov");
    await harbor.waitFor(); await video.waitFor();
    assert.deepEqual(await mobile.evaluate(() => window.aePhotoGalleryFixture), ["import:photos"]);
    assert.equal(await harbor.locator("img").count(), 0, "thumbnail capability is not fabricated");
    await button(albumBar, "New album").tap();
    await albumBar.getByRole("textbox", { name: "Album name" }).fill("Harbor");
    await button(albumBar, "Save album").tap();
    await button(albumBar, "Recents").tap();
    await video.tap();
    const viewer = mobile.getByRole("dialog", { name: "Viewing Harbor approach.mov" });
    await button(viewer, platform === "ios" ? "Open in Quick Look" : "Open in file viewer").tap();
    await button(viewer, "Export copy").tap();
    await button(viewer, "Select for Rift").tap();
    await button(viewer, "Add to album").tap();
    await button(viewer, "Harbor").tap();
    await button(viewer, "Close photo").tap();
    await viewer.waitFor({ state: "hidden" });
    await mobile.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open Harbor approach.mov");
    assert.deepEqual(await mobile.evaluate(() => window.aePhotoGalleryFixture),
      ["import:photos", "preview:import-video", "export:import-video", "select:import-video"]);
    await harbor.tap();
    const remover = mobile.getByRole("dialog", { name: "Viewing Harbor aerial.heic" });
    await button(remover, "Remove imported copy").tap();
    assert.equal((await mobile.evaluate(() => window.aePhotoGalleryFixture)).includes("remove:import-photo"), false);
    await button(remover, "Confirm remove imported copy").tap();
    await harbor.waitFor({ state: "detached" });
    assert.equal((await mobile.evaluate(() => window.aePhotoGalleryFixture)).at(-1), "remove:import-photo");
    await mobile.reload();
    await button(mobile, "Workspace").tap();
    await button(mobile, "Images & Videos").tap();
    await button(albumBar, "Harbor").tap();
    await video.waitFor();
    assert.equal(await harbor.count(), 0);
    await mobile.close();
  }
} finally {
  await browser.close();
}
