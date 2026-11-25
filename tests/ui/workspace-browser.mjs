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
  const importButton = button(desktop, "Import files");
  assert.equal(await importButton.innerText(), "", "Desktop import is an icon shortcut");
  assert.equal(await importButton.getAttribute("title"), "Import files");
  const filePicker = desktop.waitForEvent("filechooser");
  await importButton.press("Enter");
  await (await filePicker).setFiles([
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
  await large.locator('input[type="file"][aria-label="Import files"]').setInputFiles(Array.from({ length: 52 }, (_, index) => ({
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

  const home = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await home.goto(root + "/desktop-visual.html?route=home");
  const manage = button(home, "Manage devices");
  await manage.waitFor();
  assert.equal(await manage.innerText(), "");
  assert.equal(await manage.getAttribute("title"), "Manage devices");
  await snapped(home, "desktop-home-polished");
  await manage.press("Enter");
  const unpair = button(home, "Unpair Mira’s iPhone");
  await unpair.waitFor();
  assert.equal(await unpair.innerText(), "");
  await unpair.press("Enter");
  const confirmation = home.getByRole("group", { name: "Unpair Mira’s iPhone?", exact: true });
  await button(confirmation, "Confirm unpair").waitFor();
  await button(confirmation, "Keep paired").press("Escape");
  assert.equal(await focused(unpair), true);
  await snapped(home, "desktop-devices-polished");
  await home.close();

  const activity = await browser.newPage({ viewport: { width: 510, height: 780 }, colorScheme: "light" });
  await activity.goto(root + "/desktop-visual.html?route=activity&inboxFixture=1&scheme=light");
  const inbox = activity.getByRole("region", { name: "Inbox", exact: true });
  const verify = button(inbox, "Check integrity for Verified survey.pdf");
  await verify.waitFor();
  assert.equal(await verify.innerText(), "");
  await verify.press("Enter");
  await inbox.getByText("File integrity verified.", { exact: true }).waitFor();
  assert.equal(await focused(verify), true);
  const search = inbox.getByRole("searchbox", { name: "Find a file", exact: true });
  await search.fill("not listed");
  await search.press("Enter");
  await inbox.getByText("No matching files.", { exact: true }).waitFor();
  await button(inbox, "Refresh Inbox").press("Enter");
  await inbox.getByText("No matching files.", { exact: true }).waitFor();
  await search.fill("");
  await button(inbox, "Search Inbox").click();
  await verify.waitFor();
  assert.equal(await activity.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await snapped(activity, "desktop-activity-inbox-polished");
  await activity.close();

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
  console.log("Workspace browser journeys passed: desktop documents; iOS and narrow Android library, focus and dock");
} finally {
  await browser.close();
}
