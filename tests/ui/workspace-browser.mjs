import assert from "node:assert/strict";
import { verifyCollectionsGallery } from "./collections-gallery-integration-browser.mjs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReceivedActivity } from "./received-activity-browser.mjs";
const module = process.env.AERIFT_PLAYWRIGHT_MODULE;
const { chromium } = await import(module ? pathToFileURL(module).href : "playwright");
const root = process.env.AERIFT_FIXTURE_URL ?? "http://127.0.0.1:4175";
const evidence = process.env.AERIFT_WORKSPACE_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
const executablePath = process.env.AERIFT_CHROMIUM_PATH ?? process.env.AERIFT_CHROMIUM;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const snapped = async (page, name) => {
  if (!evidence) return;
  await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" });
};
const button = (page, name) => page.getByRole("button", { name, exact: true });
const heading = (page, name) => page.getByRole("heading", { name, exact: true, level: 3 });
const focused = locator => locator.evaluate(node => document.activeElement === node);
const verifyHeader = async page => {
  const header = page.locator("header.ae-compact-header");
  const logo = header.getByRole("img", { name: "AeRift", exact: true });
  const status = header.getByRole("group", { name: "App status" });
  await logo.evaluate(el => el.decode());
  const [bar, mark] = await Promise.all([header.boundingBox(), logo.boundingBox()]);
  assert.ok(bar && mark && Math.abs(bar.x + bar.width / 2 - mark.x - mark.width / 2) <= 1);
  assert.equal(await logo.getAttribute("src"), "/branding/aerift-mark-transparent.png");
  assert.equal(await status.getByRole("img").count(), 2);
  assert.equal(await status.getByRole("button").count(), 0);
  assert.equal(await header.locator(".ae-nav-brand, .ae-nav-tools").count(), 0);
};

const assertFloatingNoteTools = async (editor, required) => {
  assert.equal(await editor.getByRole("combobox", { name: /category/i }).count(), 0, "no always-visible category dropdown");
  const canvas = editor.locator(".aw-note-canvas");
  const tools = canvas.getByRole("group", { name: "Note tools", exact: true });
  for (const name of required) {
    const icon = button(tools, name);
    await icon.waitFor();
    assert.equal(await icon.innerText(), "", name + " is an icon inside the writing surface");
  }
  const [bar, body] = await Promise.all([tools.boundingBox(),
    canvas.getByRole("textbox", { name: "Note", exact: true }).boundingBox()]);
  assert.ok(bar && body && bar.y + bar.height <= body.y + 1, "floating tools do not cover the first line");
  assert.ok(await tools.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "all icons fit without horizontal scrolling");
};
const open = async (page, name) => {
  await button(page, name).click();
  assert.equal(await focused(heading(page, name)), true, "focus lands in opened workspace");
};
const back = async (page, name) => {
  await button(page, "Back to Workspace").click();
  assert.equal(await focused(button(page, name)), true, "focus returns to originating card");
};
try {
  await verifyCollectionsGallery(browser, root);
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  await desktop.goto(root + "/desktop-visual.html?route=workspace&scheme=dark");
  await verifyHeader(desktop);
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
  const fileSearch = desktop.getByRole("searchbox", { name: "Search imported files", exact: true });
  await fileSearch.fill("report");
  await fileSearch.press("Enter");
  await desktop.getByRole("checkbox", { name: "Report.pdf" }).waitFor();
  assert.equal(await desktop.getByRole("checkbox", { name: "Sketch.png" }).count(), 0);
  await desktop.getByText("Recent searches", { exact: true }).click();
  await button(desktop, "report").waitFor();
  await button(desktop, "Clear recent searches").click();
  assert.equal(await desktop.getByText("Recent searches", { exact: true }).count(), 0);
  await back(desktop, "File Browser");
  await open(desktop, "Documents");
  await desktop.getByRole("checkbox", { name: "Report.pdf" }).waitFor();
  assert.equal(await desktop.getByRole("checkbox", { name: "Sketch.png" }).count(), 0);
  await desktop.getByRole("button", { name: "Actions for Report.pdf" }).click();
  await button(desktop, "File details").click();
  await desktop.getByRole("link", { name: "Save a copy" }).waitFor();
  await snapped(desktop, "desktop-documents-dark");
  await back(desktop, "Documents");
  await open(desktop, "Notes");
  const sidebar = desktop.getByRole("complementary", { name: "Notes", exact: true });
  const editor = desktop.getByRole("region", { name: "Note editor", exact: true });
  await button(sidebar, "New category").click();
  await desktop.getByRole("textbox", { name: "Category name" }).fill("Work projects");
  await button(desktop, "Violet color").click();
  await button(desktop, "Star icon").click();
  await button(desktop, "Save category").click();
  const workCategory = sidebar.getByRole("button", { name: /^Work projects/ });
  assert.equal(await workCategory.locator("svg").getAttribute("data-category-color"), "violet");
  await button(sidebar, "New note").click();
  const first = editor.getByRole("textbox", { name: "Title", exact: true });
  await first.fill("Door project");
  await editor.getByRole("textbox", { name: "Note", exact: true }).fill("Trim measurements");
  for (const name of ["Bold", "Heading", "Preview", "Save note"]) {
    assert.equal(await button(editor, name).innerText(), "", name + " uses an icon only");
  }
  await button(editor, "Heading").click();
  await button(editor, "Preview").click();
  await editor.getByRole("region", { name: "Note preview" }).getByRole("heading", { name: "Trim measurements" }).waitFor();
  await button(editor, "Save note").click();
  await sidebar.getByRole("button", { name: /Door project/ }).waitFor();
  await sidebar.getByRole("button", { name: /^All Notes/ }).click();
  await button(sidebar, "New note").click();
  await first.fill("Newer note");
  assert.equal(await button(editor, "Save note").isDisabled(), true, "a title alone is incomplete");
  await editor.getByRole("textbox", { name: "Note", exact: true }).fill("Second note text");
  await button(editor, "Save note").click();
  await sidebar.getByRole("button", { name: /Newer note/ }).waitFor();
  await sidebar.getByRole("button", { name: /^Recents/ }).click();
  assert.match(await sidebar.locator(".ae-note-sidebar-note").first().innerText(), /Newer note/);
  await sidebar.getByRole("button", { name: /^Work projects/ }).click();
  assert.equal(await sidebar.getByRole("button", { name: /Newer note/ }).count(), 0);
  await sidebar.getByRole("button", { name: /Door project/ }).click();
  assert.equal(await first.inputValue(), "Door project");
  const largeEditor = editor.getByRole("textbox", { name: "Note", exact: true });
  await desktop.waitForFunction(() => {
    const field = document.querySelector(".aw-desktop-note-form textarea:not([hidden])");
    return field && field.getBoundingClientRect().height >= 350;
  }, null, { timeout: 3000 });
  assert.ok((await largeEditor.boundingBox()).height >= 350, "Notes keeps a large desktop editor");
  await assertFloatingNoteTools(editor, ["Bold", "Markdown", "Preview", "Move note to category", "Save note", "Delete note"]);
  await snapped(desktop, "desktop-notes-sidebar-editor");
  const categoryIcon = button(editor, "Move note to category");
  const categoryChoices = editor.getByRole("group", { name: "Move note to category", exact: true });
  await categoryIcon.press("Enter");
  const currentCategory = button(categoryChoices, "Work projects");
  assert.equal(await currentCategory.getAttribute("aria-pressed"), "true");
  await currentCategory.press("Escape");
  assert.equal(await focused(categoryIcon), true);
  assert.equal(await categoryChoices.count(), 0);
  await categoryIcon.click();
  await button(categoryChoices, "Uncategorized").click();
  await categoryIcon.click();
  assert.equal(await button(categoryChoices, "Uncategorized").getAttribute("aria-pressed"), "true");
  await currentCategory.click();
  await sidebar.getByRole("searchbox", { name: "Search notes" }).fill("unrelated");
  await sidebar.getByText("No notes match this search.").waitFor();
  await desktop.reload();
  await open(desktop, "Notes");
  await workCategory.click();
  await button(desktop, "Edit category").click();
  assert.equal(await button(desktop, "Violet color").getAttribute("aria-pressed"), "true");
  assert.equal(await button(desktop, "Star icon").getAttribute("aria-pressed"), "true");
  await button(desktop, "Cancel category edit").click();
  await sidebar.getByRole("button", { name: /Door project/ }).waitFor();
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
  await verifyReceivedActivity(activity, { expectedTime: "2026-11-25T14:02:00.000Z" });
  const timeline = inbox.getByRole("region", { name: "Receipt timeline" });
  const newest = timeline.getByRole("button").first();
  assert.equal(await newest.getAttribute("aria-label"), "View timeline entry for Received sketch.txt");
  await newest.press("Enter");
  const receiptPreview = inbox.getByRole("region", { name: "File preview", exact: true });
  await button(receiptPreview, "Preview file").click();
  await receiptPreview.getByText("<script>preview is inert text</script>", { exact: true }).waitFor();
  assert.equal(await receiptPreview.locator("script").count(), 0);
  await snapped(activity, "desktop-activity-inbox-polished");
  await activity.close();

  const receivedAndroid = await browser.newPage({ viewport: { width: 360, height: 800 } });
  await receivedAndroid.goto(root + "/mobile.html?platform=android&receivedFixture=1");
  await receivedAndroid.getByRole("button", { name: /^Activity(?:\s*Transfers active)?$/ }).click();
  const androidFiles = receivedAndroid.getByRole("region", { name: "Received files", exact: true });
  await androidFiles.getByRole("searchbox", { name: "Find a file", exact: true }).fill("chart");
  await button(androidFiles, "View received Received chart.pdf").click();
  await button(androidFiles, "Open file").click();
  await androidFiles.getByText("Opened received copy.", { exact: true }).waitFor();
  await snapped(receivedAndroid, "android-activity-received-library");
  await receivedAndroid.close();

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
    await verifyHeader(page);
    assert.equal(await page.locator("header.ae-compact-header").getByRole("button").count(), 0);
    const dockSettings = button(dock, "Settings");
    assert.equal(await dockSettings.count(), 1);
    await snapped(page, platform + "-workspace");
    await open(page, "File Browser");
    await button(page, "Import files").click();
    await page.getByText("Navigation chart.pdf", { exact: true }).last().waitFor();
    await back(page, "File Browser");
    await open(page, "Documents");
    const docs = page.getByRole("region", { name: "Imported documents" });
    await docs.getByText("Navigation chart.pdf", { exact: true }).waitFor();
    await back(page, "Documents");
    await open(page, "Notes");
    const mobileNotes = page.getByRole("complementary", { name: "Notes", exact: true });
    await mobileNotes.waitFor();
    const mobileEditor = page.getByRole("region", { name: "Note editor", exact: true });
    assert.equal(await mobileEditor.count(), 0, "phone opens the note list, not the editor");
    await button(mobileNotes, "New category").click();
    await page.getByRole("textbox", { name: "Category name" }).fill("Weekend");
    await button(page, "Save category").click();
    await button(mobileNotes, "New note").click();
    await mobileEditor.waitFor();
    assert.equal(await mobileNotes.count(), 0, "editor replaces the note list on a phone");
    await mobileEditor.getByRole("textbox", { name: "Title", exact: true }).fill("Weekend plan");
    await mobileEditor.getByRole("textbox", { name: "Note", exact: true }).fill("Pick up lumber");
    assert.equal(await button(mobileEditor, "Checklist").innerText(), "");
    await button(mobileEditor, "Checklist").click();
    await button(mobileEditor, "Preview").click();
    await mobileEditor.getByRole("region", { name: "Note preview" }).getByText("☐ Pick up lumber").waitFor();
    await button(mobileEditor, "Save note").click();
    await mobileEditor.getByText("Note saved.", { exact: true }).waitFor();
    await button(mobileEditor, "Back to notes").click();
    await mobileNotes.getByRole("searchbox", { name: "Search notes" }).fill("lumber");
    await mobileNotes.getByRole("button", { name: /Weekend plan/ }).waitFor();
    await snapped(page, platform + "-notes-list");
    await mobileNotes.getByRole("button", { name: /Weekend plan/ }).click();
    await mobileEditor.getByRole("textbox", { name: "Note", exact: true }).waitFor();
    await assertFloatingNoteTools(mobileEditor, ["Bold", "Markdown", "Preview", "Move note to category", "Save note", "Delete note"]);
    await snapped(page, platform + "-notes-full-editor");
    await button(mobileEditor, "Move note to category").click();
    const categories = mobileEditor.getByRole("group", { name: "Move note to category", exact: true });
    assert.equal(await button(categories, "Weekend").getAttribute("aria-pressed"), "true");
    await button(categories, "Weekend").click();
    assert.equal(await categories.count(), 0);
    await button(mobileEditor, "Back to notes").click();
    await back(page, "Notes");
    assert.equal(await button(page, "Clipboard").count(), 0, "Clipboard is not enabled by default");
    await button(dock, "Settings").click();
    const controls = page.getByRole("dialog", { name: "Control Center" });
    await controls.getByRole("checkbox", { name: "Clipboard", exact: true }).check();
    await button(controls, "Close").click();
    await open(page, "Clipboard");
    await page.getByText("New text pin", { exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Shop address");
    await page.getByRole("textbox", { name: "Text to pin", exact: true }).fill("Synthetic clipboard pin");
    await button(page, "Pin text").click();
    await page.getByRole("searchbox", { name: "Search pinned text" }).fill("synthetic");
    await page.getByText("Shop address", { exact: true }).waitFor();
    assert.equal(await page.getByText("Synthetic clipboard pin", { exact: true }).count(), 0,
      "clipboard content is not exposed in the list");
    await page.getByRole("searchbox", { name: "Search pinned text" }).fill("unrelated");
    await page.getByText("No pins match your filters.").waitFor();
    await back(page, "Clipboard");
    await open(page, "Collections");
    await button(page, "New collection").click();
    await page.getByRole("textbox", { name: "Collection name", exact: true }).fill("Weekend items");
    await button(page, "Create collection").click();
    const contents = page.getByRole("region", { name: "Weekend items contents" });
    await contents.getByRole("searchbox", { name: "Find an item to add" }).fill("Weekend plan");
    await button(contents, "Add Weekend plan to collection").click();
    await button(contents, "Remove Weekend plan from collection").click();
    await contents.getByText("This collection is empty.").waitFor();
    await back(page, "Collections");
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
  const remote = await browser.newPage({ viewport: { width: 1280, height: 900 },
    colorScheme: "dark", reducedMotion: "reduce" });
  await remote.goto(root + "/desktop-visual.html?privateRemoteIsland=1&scheme=dark");
  const activeRemote = remote.getByRole("complementary", { name: "Active transfers", exact: true });
  await remote.getByText("Tidal charts.pdf", { exact: true }).waitFor();
  assert.equal(await activeRemote.count(), 0, "the accepted Remote offer has no data progress yet");
  await remote.evaluate(() => window.setRemoteIslandFixture("transferring", 1200));
  const fileProgress = activeRemote.getByRole("progressbar", { name: "Receiving Tidal charts.pdf", exact: true });
  const folderProgress = activeRemote.getByRole("progressbar", { name: "Receiving Field recordings", exact: true });
  await folderProgress.waitFor();
  await fileProgress.waitFor();
  assert.equal(await fileProgress.getAttribute("aria-valuenow"), "30");
  assert.equal(await folderProgress.getAttribute("aria-valuenow"), "30");
  assert.equal(await activeRemote.getByText("2 items", { exact: true }).count(), 1);
  await snapped(remote, "desktop-private-remote-receive-island");
  await remote.evaluate(() => window.setRemoteIslandFixture("transferring", 4000));
  await activeRemote.getByText("Checking staged bytes · save separately", { exact: true }).waitFor();
  assert.equal(await folderProgress.getAttribute("aria-valuenow"), "100");
  assert.equal(await remote.getByText("Saved to the destination you chose.", { exact: true }).count(), 0);
  await remote.evaluate(() => window.setRemoteIslandFixture("completed", 4000));
  await activeRemote.waitFor({ state: "hidden" });
  await remote.getByText("Folder data verified. Not exported yet.", { exact: true }).waitFor();
  await button(remote, "Save verified folder without replacing files").waitFor();
  await remote.getByLabel("Other device’s VPN address and port").fill("100.88.1.2:48888");
  for (const kind of ["file", "folder"]) {
    const recipientLabel = kind === "file" ? "Authorized recipient" : "Folder recipient";
    const recipient = remote.getByRole("combobox", { name: recipientLabel, exact: true });
    const send = button(remote, "Choose " + kind + " to send");
    assert.equal(await send.isDisabled(), true, "an unselected recipient cannot send");
    const eligible = recipient.getByRole("option", { name: /^Studio PC/ });
    await eligible.waitFor({ state: "attached" });
    const eligibleValue = await eligible.getAttribute("value");
    await remote.getByLabel(recipientLabel, { exact: true }).selectOption(eligibleValue);
    assert.equal(await recipient.inputValue(), eligibleValue, "the exact eligible device is selected");
    await send.click();
    const progress = (state, bytes) => remote.evaluate(([phase, n]) => window.remoteUploadFixture.progress(phase, n), [state, bytes]);
    assert.equal(await progress("accepted", 0), true);
    assert.equal(await activeRemote.count(), 0);
    assert.equal(await progress("transferring", 1600), true);
    const outgoingName = kind === "file" ? "Outgoing survey.wav" : "Outgoing folder";
    const outgoing = activeRemote.getByRole("progressbar", { name: "Sending " + outgoingName, exact: true });
    await outgoing.waitFor();
    assert.equal(await outgoing.getAttribute("aria-valuenow"), "40");
    await progress("transferring", 4000);
    await activeRemote.getByText(kind === "file" ? "Awaiting verification" :
      "Recipient checking staged bytes · export is separate", { exact: true }).waitFor();
    assert.equal(await outgoing.getAttribute("aria-valuenow"), "100");
    await remote.evaluate(() => window.remoteUploadFixture.finish());
    await activeRemote.waitFor({ state: "hidden" });
    await progress("transferring", 4000); // an obsolete callback cannot resurrect a finished operation
    await remote.getByText(kind === "file" ? "Delivered. The recipient verified the file." :
      "The recipient verified the folder data. This is not confirmation that it was saved to their chosen location.", { exact: true }).waitFor();
    assert.equal(await activeRemote.count(), 0);
  }
  await remote.close();

  console.log("Workspace browser journeys passed: desktop documents; iOS and narrow Android library, focus and dock");
} finally {
  await browser.close();
}

