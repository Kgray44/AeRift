import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const module = process.env.AERIFT_PLAYWRIGHT_MODULE;
const { chromium } = await import(module ? pathToFileURL(module).href : "playwright");
const root = process.env.AERIFT_FIXTURE_URL ?? "http://127.0.0.1:4175";
const evidence = process.env.AERIFT_WORKSPACE_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
const browser = await chromium.launch();
const snapped = async (page, name) => {
  if (!evidence) return;
  await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" });
};
const button = (page, name) => page.getByRole("button", { name, exact: true });
const heading = (page, name) => page.getByRole("heading", { name, exact: true, level: 3 });
const focused = locator => locator.evaluate(node => document.activeElement === node);
const open = async (page, name) => {
  await button(page, name).click();
  assert.equal(await focused(heading(page, name)), true, "focus lands in opened workspace");
};
const back = async (page, name) => {
  await button(page, "Back to Workspace").click();
  assert.equal(await focused(button(page, name)), true, "focus returns to originating card");
};
try {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  await desktop.goto(root + "/desktop-visual.html?route=workspace&scheme=dark");
  await snapped(desktop, "desktop-workspace-dark");
  await open(desktop, "File Browser");
  await desktop.getByLabel("Import files", { exact: true }).setInputFiles([
    { name: "Report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") },
    { name: "Sketch.png", mimeType: "image/png", buffer: Buffer.from("synthetic image bytes") },
  ]);
  await desktop.getByRole("checkbox", { name: "Report.pdf" }).waitFor();
  await back(desktop, "File Browser");
  await open(desktop, "Documents");
  await desktop.getByRole("checkbox", { name: "Report.pdf" }).waitFor();
  assert.equal(await desktop.getByRole("checkbox", { name: "Sketch.png" }).count(), 0);
  await desktop.getByRole("button", { name: "Actions for Report.pdf" }).click();
  await button(desktop, "File details").click();
  await desktop.getByRole("link", { name: "Save a copy" }).waitFor();
  await snapped(desktop, "desktop-documents-dark");
  await desktop.close();

  for (const platform of ["ios", "android"]) {
    const page = await browser.newPage({ viewport: { width: platform === "ios" ? 390 : 320, height: 844 },
      deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: platform === "ios" ? "light" : "dark" });
    await page.goto(root + "/mobile.html?friendsFixture=1&platform=" + platform);
    const dock = page.getByRole("navigation", { name: "AeRift destinations" });
    await dock.getByRole("button", { name: "Workspace", exact: true }).click();
    assert.equal(await dock.locator(".af-dock-fluid").count(), 1);
    const bounds = await dock.getByRole("button").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
    assert.ok(bounds.every(b => b.width >= 44 && b.height >= 44));
    assert.ok(bounds.every((b, i) => i === 0 || b.left >= bounds[i - 1].right - 1));
    await snapped(page, platform + "-workspace");
    await open(page, "File Browser");
    await button(page, "Import files").click();
    await page.getByText("Navigation chart.pdf", { exact: true }).last().waitFor();
    await back(page, "File Browser");
    await open(page, "Documents");
    const docs = page.getByRole("region", { name: "Imported documents" });
    await docs.getByText("Navigation chart.pdf", { exact: true }).waitFor();
    await back(page, "Documents");
    const settle = async () => {
      await page.waitForFunction(() => !document.querySelector(".af-dock-bead")?.getAnimations().some(anim => anim.playState === "running"));
    };
    await settle();
    const before = await dock.locator(".af-dock-fluid").boundingBox();
    await dock.getByRole("button", { name: "Rift", exact: true }).click();
    await settle();
    const after = await dock.locator(".af-dock-fluid").boundingBox();
    assert.notEqual(before.x, after.x);
    assert.equal(await dock.getByRole("button", { name: "Rift", exact: true }).getAttribute("aria-current"), "page");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dock.getByRole("button", { name: "Home", exact: true }).click();
    assert.equal(await dock.locator(".af-dock-fluid").evaluate(node => getComputedStyle(node).transitionDuration), "0s");
    assert.equal(await dock.locator(".af-dock-bead").evaluate(node => node.getAnimations().length), 0);
    await page.close();
  }
  console.log("Workspace browser journeys passed: desktop documents; iOS and narrow Android library, focus and dock");
} finally {
  await browser.close();
}
