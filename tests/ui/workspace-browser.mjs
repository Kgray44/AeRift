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

  const large = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await large.goto(root + "/desktop-visual.html?route=workspace&scheme=dark");
  await open(large, "File Browser");
  await large.getByLabel("Import files", { exact: true }).setInputFiles(Array.from({ length: 52 }, (_, index) => ({
    name: `Large-${index}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7"),
  })));
  const saved = large.getByRole("region", { name: "Saved file browser", exact: true });
  await saved.getByText("Page 1 of 2").waitFor();
  assert.equal(await saved.getByRole("checkbox").count(), 48);
  await saved.getByRole("checkbox", { name: "Large-0.pdf" }).check();
  await button(saved, "Next page").click();
  assert.equal(await saved.getByRole("checkbox").count(), 4);
  await saved.getByRole("checkbox", { name: "Large-51.pdf" }).check();
  await button(saved, "Remove selected (2)").waitFor();
  await button(saved, "Previous page").click();
  assert.equal(await saved.getByRole("checkbox", { name: "Large-0.pdf" }).isChecked(), true);
  await back(large, "File Browser");
  assert.equal(await button(large, "Documents").getByText("52 items").count(), 1);
  // Exercise an installed v1 writer against the same persisted browser origin.
  const prior = await large.evaluate(async () => {
    const read = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const db = await read(indexedDB.open("aerift.desktop.workspace", 1));
    const storeNames = [...db.objectStoreNames];
    const tx = db.transaction("objects", "readwrite");
    const finish = new Promise((resolve, reject) => {
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    const store = tx.objectStore("objects");
    const rows = await read(store.getAll());
    const edit = rows.find(row => JSON.parse(row.document).name === "Large-0.pdf");
    const remove = rows.find(row => JSON.parse(row.document).name === "Large-51.pdf");
    store.put({ ...edit, document: JSON.stringify({ ...JSON.parse(edit.document), name: "Prior edit.pdf" }) });
    store.delete(remove.id);
    await finish;
    db.close();
    return { storeNames, count: rows.length, fileContents: await edit.asset.text() };
  });
  assert.deepEqual(prior, { storeNames: ["objects"], count: 52, fileContents: "%PDF-1.7" });
  await large.reload();
  await open(large, "Documents");
  const updated = large.getByRole("region", { name: "Saved documents", exact: true });
  await updated.getByText("Page 1 of 2").waitFor();
  await button(updated, "Next page").click();
  assert.equal(await updated.getByRole("checkbox").count(), 3);
  await large.close();

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
    assert.equal(await dock.locator(".af-label-compact").filter({ hasText: /^Space$/ }).isVisible(), true);
    assert.ok(await dock.locator(".af-dock-label").evaluateAll(labels => labels.every(label => label.scrollWidth <= label.clientWidth + 1)));
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
    const manual = page.getByRole("region", { name: "Manual transfer" });
    await manual.getByRole("heading", { name: "Send manually" }).waitFor();
    // The fixture opens Rift with an existing incoming offer.
    await button(manual, "Choose another file").click();
    await manual.getByText("Harbor survey.pdf", { exact: true }).waitFor();
    assert.equal(await button(manual, "Send file").count(), 0, "sending needs a recipient");
    await page.locator("label.ae-spatial-peer").filter({ hasText: "Studio PC" }).click();
    await button(manual, "Send file").waitFor();
    assert.ok(await manual.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    // A pending offer intentionally adds a screen-reader-only activity status.
    await dock.getByRole("button", { name: /^Activity(?:\s*Transfers active)?$/ }).click();
    await page.waitForFunction(() => document.activeElement?.matches("h2") &&
      document.activeElement.textContent === "Activity");
    const status = page.getByRole("region", { name: "Transfer status" });
    const history = page.getByRole("region", { name: "Transfer history" });
    await status.getByRole("heading", { name: "Incoming offers" }).waitFor();
    const filter = history.getByRole("combobox", { name: /^Show/ });
    await filter.selectOption("finished");
    await history.getByText("Harbor survey.pdf", { exact: true }).waitFor();
    await button(status, "Accept").waitFor();
    assert.ok(await history.evaluate(el =>
      !!(document.querySelector(".ae-rift-board").compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)));
    await button(dock, "Devices").click();
    const nearby = page.getByRole("region", { name: "Nearby Devices", exact: true });
    assert.equal(await nearby.getAttribute("data-material"), "content");
    const unpair = button(nearby, "Unpair Studio PC");
    await unpair.click();
    const prompt = nearby.getByRole("group", { name: "Unpair Studio PC?" });
    const keep = button(prompt, "Keep paired");
    assert.equal(await focused(keep), true, "focus defaults to the non-destructive choice");
    await keep.press("Escape");
    assert.equal(await focused(unpair), true, "dismissing restores focus to the exact device");
    assert.equal(await prompt.count(), 0);
    assert.ok(await nearby.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await snapped(page, platform + "-devices");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dock.getByRole("button", { name: "Home", exact: true }).click();
    assert.equal(await dock.locator(".af-dock-fluid").evaluate(node => getComputedStyle(node).transitionDuration), "0s");
    assert.equal(await dock.locator(".af-dock-bead").evaluate(node => node.getAnimations().length), 0);
    await page.close();
  }
  for (const platform of ["windows", "ios", "android"]) {
    const desktop = platform === "windows";
    const page = await browser.newPage({ viewport: { width: desktop ? 1280 : 390, height: 846 },
      colorScheme: desktop ? "dark" : "light", isMobile: !desktop, hasTouch: !desktop });
    const base = desktop ? "/desktop-visual.html?route=home" : "/mobile.html?platform=" + platform;
    await page.goto(root + base + "&islandFixture=1");
    const setReceipt = (direction, state, bytes) => page.evaluate(([d, s, b]) => window.aeTransferIslandFixture.set(d, s, b),
      [direction, state, bytes]);
    const island = page.getByRole("complementary", { name: "Active transfers", exact: true });
    assert.equal(await island.count(), 0, "pending offers never show the island");
    await setReceipt("incoming", "accepted", 0);
    assert.equal(await island.count(), 0, "acceptance without data still does not show the island");
    await setReceipt("incoming", "transferring", 400);
    const down = island.getByRole("progressbar", { name: "Receiving Tidal charts.pdf", exact: true });
    await down.waitFor();
    assert.equal(await down.getAttribute("aria-valuenow"), "10");
    await island.getByText("Download speed and time not yet available", { exact: true }).waitFor();
    await setReceipt("outgoing", "transferring", 800);
    const up = island.getByRole("progressbar", { name: "Sending Survey recording.wav", exact: true });
    await up.waitFor();
    assert.equal(await up.getAttribute("aria-valuenow"), "20");
    // The estimator deliberately requires at least a quarter second between positive samples.
    await page.waitForTimeout(300);
    await setReceipt("incoming", "transferring", 1_600);
    await setReceipt("outgoing", "transferring", 2_000);
    await island.getByText(/^Download .+\/s · .+ left$/).waitFor();
    await island.getByText(/^Upload .+\/s · .+ left$/).waitFor();
    assert.equal(await island.getByRole("progressbar").count(), 2);
    const surface = island.locator(".ae-transfer-island");
    const sampled = () => surface.locator("xpath=self::*[@data-ae-lens='sampled']");
    await sampled().waitFor();
    assert.equal(await surface.getAttribute("data-material"), "chrome");
    const optical = await surface.evaluate(node => {
      const shell = node.closest(".ae-shell");
      const crop = node.querySelector(".ae-transfer-island-optical");
      const source = shell.querySelector(".ae-glass-optics");
      const at = node.getBoundingClientRect(), sky = source.getBoundingClientRect();
      const x = Math.floor((at.x - sky.x) * source.width / sky.width);
      const y = Math.floor((at.y - sky.y) * source.height / sky.height);
      const cx = Math.floor(crop.width / 2), cy = Math.floor(crop.height / 2);
      const pixel = (canvas, col, row) => Array.from(canvas.getContext("2d").getImageData(col, row, 1, 1).data);
      return { usable: crop.width > 2 && crop.height > 2 && getComputedStyle(crop).display === "block" &&
          source.width >= crop.width && shell.dataset.aeOptics === "ready",
        sameShell: node.closest(".ae-shell").contains(source),
        retainedCssFill: getComputedStyle(node).backgroundColor,
        scheme: node.closest(".ae-theme").dataset.appearance,
        center: pixel(crop, cx, cy),
        field: pixel(source, x + cx, y + cy) };
    });
    assert.equal(optical.usable && optical.sameShell, true);
    assert.equal(optical.retainedCssFill, "rgba(0, 0, 0, 0)", "sampled surface is not painted over by a second material");
    assert.equal(optical.scheme, desktop ? "dark" : "light");
    assert.equal(optical.center[3], 255);
    assert.ok(Math.max(...optical.center.slice(0, 3)) > 0);
    assert.notDeepEqual(optical.center, optical.field, "the active island canvas is refracted, not a flat copy of the scene");
    await snapped(page, platform + "-transfer-island-sampled-" + optical.scheme);
    const expandedHeight = await surface.evaluate(node => node.querySelector("canvas").height);
    const lensHandle = await surface.elementHandle();
    const minimize = button(island, "Minimize transfer island");
    await minimize.press("Enter");
    const expand = button(island, "Expand transfer island");
    await expand.waitFor();
    assert.equal(await focused(expand), true);
    assert.equal(await expand.getAttribute("aria-expanded"), "false");
    assert.equal(await island.getByRole("progressbar").count(), 0);
    await page.waitForFunction(({ node, height }) => node.dataset.aeLens === "sampled" &&
      node.querySelector("canvas").height < height, { node: lensHandle, height: expandedHeight });
    const minimizedHeight = await surface.evaluate(node => node.querySelector("canvas").height);
    await expand.press("Enter");
    await down.waitFor();
    await page.waitForFunction(({ node, height }) => node.dataset.aeLens === "sampled" &&
      node.querySelector("canvas").height > height, { node: lensHandle, height: minimizedHeight });

    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await island.evaluate(node => getComputedStyle(node).transitionDuration), "0s");
    await sampled().waitFor(); // reduced motion does not disable the real glass recipe
    const bounds = await island.locator(".ae-transfer-island").boundingBox();
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - page.viewportSize().width / 2) <= 1);
    if (!desktop) {
      const mobileDock = page.getByRole("navigation", { name: "AeRift destinations" });
      const dockBox = await mobileDock.boundingBox();
      assert.ok(bounds.y + bounds.height <= dockBox.y, "island and navigation do not overlap");
      await button(mobileDock, "Devices").click();
      await down.waitFor();
    }
    await snapped(page, platform + "-transfer-island");
    await setReceipt("incoming", "transferring", 4_000);
    await island.getByText("Awaiting verification", { exact: true }).waitFor();
    assert.equal(await down.getAttribute("aria-valuenow"), "100");
    await setReceipt("incoming", "completed", 4_000);
    await down.waitFor({ state: "hidden" });
    await setReceipt("outgoing", "cancelled", 2_000);
    await island.waitFor({ state: "hidden" });
    await page.locator(".ae-transfer-island[data-ae-lens='sampled']").waitFor({ state: "detached" });
    await page.close();
  }
  console.log("Workspace browser journeys passed: desktop documents; iOS and narrow Android library, focus and dock");
} finally {
  await browser.close();
}
