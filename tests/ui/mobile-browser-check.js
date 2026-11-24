async (page) => {
  page.setDefaultTimeout(7000);
  const check = (result, reason) => { if (!result) throw new Error(reason); };
  const dock = page.getByRole("navigation", { name: "AeRift destinations" });
  const go = async (name) => {
    await dock.getByRole("button", { name: new RegExp("^" + name) }).click();
    const heading = page.getByRole("heading", { name, exact: true, level: 2 });
    await heading.waitFor();
    check(await heading.evaluate(e => document.activeElement === e), name + " focus");
  };
  async function openCategory(name) {
    const back = page.getByRole("button", { name: "Back to Workspace", exact: true });
    if (await back.isVisible()) await back.click();
    await page.getByRole("button", { name, exact: true }).click();
    const heading = page.getByRole("heading", { name, exact: true, level: 3 });
    check(await heading.evaluate(el => el === document.activeElement), name + " focus");
  }
  const config = async () => {
    await page.getByRole("button", { name: "Control Center", exact: true }).click();
    return page.getByRole("dialog", { name: "Control Center" });
  };
  const screenshot = name => page.screenshot({ path: "docs/validation/evidence/mobile-workspace/" + name + ".png", animations: "disabled" });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await dock.waitFor();
  let dialog = await config();
  await dialog.getByRole("radio", { name: "Light", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator('.ae-theme[data-scheme="light"]').waitFor();
  await screenshot("light-home-390");
  await go("Workspace");
  await openCategory('Images & Videos');
  await page.getByRole("button", { name: "Choose for Rift", exact: true }).click();
  await page.getByRole("heading", { name: "Ready for Rift", exact: true }).waitFor();
  await screenshot("light-workspace-390");
  await go("Devices");
  await page.getByRole("region", { name: "Nearby and trusted devices" }).getByText("Studio PC", { exact: true }).waitFor();
  await go("Rift");
  await page.locator(".ae-dock-file").getByText("Coastline.heic", { exact: true }).waitFor();
  await page.locator("label.ae-spatial-peer").filter({ hasText: "Studio PC" }).click();
  await page.getByRole("button", { name: "Send file" }).click();
  await screenshot("light-rift-390");
  await go("Workspace");
  await page.getByRole("button", { name: "1 incoming offer", exact: true }).click();
  await page.getByRole("heading", { name: "Activity", exact: true, level: 2 }).waitFor();
  const history = page.getByRole("region", { name: "Transfer history" });
  check(await history.evaluate(region => !!(document.querySelector(".ae-rift-board")
    .compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING)), "incoming consent is first in reading order");
  await history.getByText("Awaiting confirmation", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await history.getByRole("button", { name: "Cancel transfer", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /cancelled/i }).first().waitFor();
  dialog = await config();
  await dialog.getByRole("radio", { name: "Dark", exact: true }).click();
  await dialog.getByText("Reduce motion", { exact: true }).click();
  await dialog.getByLabel("Clipboard", { exact: true }).check();
  await dialog.getByLabel("Keep final transfer outcomes after restart", { exact: true }).check();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator('.ae-theme[data-scheme="dark"]').waitFor();
  await screenshot("dark-activity-390");
  await go("Workspace");
  await openCategory('Notes');
  await page.getByText("New note", { exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Packing list");
  await page.getByLabel("Note", { exact: true }).fill("Charts and camera");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByText("Packing list", { exact: true }).waitFor();
  await openCategory('Collections');
  await page.getByText("New collection", { exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Harbor Trip");
  await page.getByRole("button", { name: "Create collection", exact: true }).click();
  await page.getByRole("combobox", { name: "Add an item" }).selectOption({ label: "Packing list" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Remove Packing list from collection" }).waitFor();
  await page.reload();
  check(await page.locator(".ae-theme").getAttribute("data-scheme") === "dark", "theme persisted");
  check(await page.locator(".ae-theme").getAttribute("data-motion") === "reduce", "motion persisted");
  await go("Workspace");
  await page.getByRole("button", { name: "Clipboard", exact: true }).waitFor();
  await openCategory('Collections');
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Remove Packing list from collection" }).waitFor();
  for (const [width, height] of [[320, 640], [844, 390], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    await go("Home");
    const buttons = await dock.getByRole("button").evaluateAll(items => items.map(i => {
      const box = i.getBoundingClientRect();
      return [box.left, box.right, box.top, box.bottom, box.width, box.height];
    }));
    check(buttons.length === 5, "all five routes at " + width);
    check(buttons.every(([l, r, t, b, w, h]) => l >= 0 && r <= width && t >= 0 && b <= height && w >= 44 && h >= 44), "dock bounds and touch targets at " + width);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scrolling at " + width);
    if (width === 1024) await screenshot("dark-home-1024");
    if (width !== 1024) await go("Devices");
  }
  await go("Workspace");
  await openCategory('Clipboard');
  await page.getByText("New text pin", { exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Dock code");
  await page.getByLabel("Text to pin", { exact: true }).fill("fixture-sensitive-text");
  await page.getByRole("button", { name: "Pin text", exact: true }).click();
  check(await page.getByText("fixture-sensitive-text", { exact: true }).count() === 0, "pin preview stays hidden");
  dialog = await config();
  await dialog.getByRole("button", { name: "Clear saved clipboard pins", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove all saved pins", exact: true }).click();
  await dialog.getByRole("button", { name: "Manage trusted devices", exact: true }).click();
  const deviceHeading = page.getByRole("heading", { name: "Devices", exact: true, level: 2 });
  await deviceHeading.waitFor();
  check(await deviceHeading.evaluate(e => document.activeElement === e), "settings-to-devices focus");
  await go("Workspace");
  await openCategory('Clipboard');
  check(await page.getByText("Dock code", { exact: true }).count() === 0, "explicit clear removed saved pin");
  await openCategory('Notes');
  await page.evaluate(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: command => {
        if (command !== "stage_ios_text") throw new Error("Unexpected fixture command");
        return new Promise(resolve => {
          window.finishMobileStage = () => resolve({ name: "Packing list.txt", sizeBytes: 17, selectionId: "fixture-note" });
        });
      },
    };
  });
  await page.getByRole("button", { name: "Send copy", exact: true }).click();
  await page.waitForFunction(() => typeof window.finishMobileStage === "function");
  await go("Devices");
  await page.evaluate(async () => {
    window.finishMobileStage();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  check(await dock.getByRole("button", { name: "Devices", exact: true }).getAttribute("aria-current") === "page",
    "a completed stage leaves the chosen route active");
  await go("Workspace");
  await page.getByRole("region", { name: "Selected object" }).getByText("Packing list.txt", { exact: true }).waitFor();
  await go("Activity");
  await history.getByText("Cancelled", { exact: true }).waitFor();
  check(await history.getByRole("button", { name: "Choose file to retry", exact: true }).count() === 0,
    "saved outcomes don't carry live actions");
  dialog = await config();
  await dialog.getByRole("button", { name: "Clear saved Activity", exact: true }).click();
  await dialog.getByRole("button", { name: "Clear saved outcomes", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  check(await history.getByText("Cancelled", { exact: true }).count() === 0, "clear removes archived outcomes");
  await go("Workspace");
  await openCategory('Collections');
  await page.evaluate(() => {
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command !== "stage_ios_text") throw new Error("Unexpected fixture command");
      window.mobileCollectionCopy = JSON.parse(args.text);
      return Promise.resolve({ name: args.name, sizeBytes: new TextEncoder().encode(args.text).length, selectionId: "fixture-collection" });
    };
  });
  await page.getByRole("button", { name: "Send collection copy", exact: true }).click();
  await page.getByRole("heading", { name: "Rift", exact: true, level: 2 }).waitFor();
  await page.locator(".ae-dock-file").getByText("AeRift - Harbor Trip.txt", { exact: true }).waitFor();
  check(await page.evaluate(() => window.mobileCollectionCopy.items[0].name === "Packing list"),
    "the staged collection copy includes its saved objects");
  await page.setViewportSize({ width: 390, height: 844 });
  await go("Workspace");
  await page.evaluate(() => {
    window.__TAURI_INTERNALS__ = { invoke: command => {
      if (command === "ios_clipboard_image_available") return Promise.resolve(true);
      if (command === "stage_ios_clipboard_image") return Promise.resolve({
        name: "Clipboard image.png", selectionId: "fixture-clipboard-image", sizeBytes: 24184,
      });
      throw new Error("Unexpected fixture command");
    } };
  });
  await openCategory('Clipboard');
  const pasteImage = page.getByRole("button", { name: "Paste image for Rift", exact: true });
  await pasteImage.waitFor();
  check(await pasteImage.isDisabled(), "clipboard image sharing starts disabled");
  dialog = await config();
  const shareClipboard = dialog.getByLabel("Allow sending clipboard copies through Rift", { exact: true });
  await shareClipboard.check();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await pasteImage.click();
  await page.getByRole("heading", { name: "Rift", exact: true, level: 2 }).waitFor();
  await page.locator(".ae-dock-file").getByText("Clipboard image.png", { exact: true }).waitFor();
  await page.locator("label.ae-spatial-peer").filter({ hasText: "Studio PC" }).click();
  const sendFile = page.getByRole("button", { name: "Send file" });
  await sendFile.waitFor();
  dialog = await config();
  await shareClipboard.uncheck();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByText("Enable clipboard sharing in Control Center to offer this file.", { exact: true }).waitFor();
  check(await sendFile.count() === 0, "revoking sharing blocks the existing clipboard selection");
  await page.locator(".ae-transfer-dock").screenshot({ path: "docs/validation/evidence/mobile-workspace/clipboard-sharing-390.png",
    animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await go("Workspace");
  await openCategory("File Browser");
  const files = page.getByRole("region", { name: "Imported files", exact: true });
  await files.getByRole("button", { name: "Import files", exact: true }).click();
  await files.getByText("Harbor log.txt", { exact: true }).waitFor();
  check((await files.getByRole("listitem").allTextContents())[0].includes("Navigation chart.pdf"),
    "file import order survives staging");
  await openCategory('Images & Videos');
  const media = page.getByRole("region", { name: "Imported photos and videos", exact: true });
  await media.getByRole("button", { name: "Import photos or videos", exact: true }).click();
  await media.getByText("Harbor approach.mov", { exact: true }).waitFor();
  check((await media.getByRole("listitem").allTextContents())[0].includes("Harbor aerial.heic"),
    "photo-library order is preserved");
  check(await media.getByText("Navigation chart.pdf", { exact: true }).count() === 0, "media filters out provider files");
  const video = media.getByRole("listitem").filter({ hasText: "Harbor approach.mov" });
  await video.getByRole("button", { name: "Preview", exact: true }).click();
  await video.getByRole("button", { name: "Export copy", exact: true }).click();
  await video.getByRole("button", { name: "Select for Rift", exact: true }).click();
  await page.getByRole("region", { name: "Selected object" }).getByText("Harbor approach.mov", { exact: true }).waitFor();
  await page.screenshot({ path: "docs/validation/evidence/mobile-workspace/media-import-tray-390.png", fullPage: true,
    animations: "disabled" });
  await go("Rift");
  await page.locator(".ae-dock-file").getByText("Harbor approach.mov", { exact: true }).waitFor();
  await go("Workspace");
  await openCategory('Images & Videos');
  await media.getByRole("button", { name: "Remove Harbor aerial.heic", exact: true }).click();
  check(await media.getByText("Harbor aerial.heic", { exact: true }).count() === 0, "removes only the selected imported copy");
  await media.getByText("Harbor approach.mov", { exact: true }).waitFor();
  await page.reload();
  await go("Workspace");
  await openCategory('Images & Videos');
  await media.getByText("Harbor approach.mov", { exact: true }).waitFor();
  check(await media.getByText("Harbor aerial.heic", { exact: true }).count() === 0, "removal survives restart");
  await media.getByRole("button", { name: "Select for Rift", exact: true }).click();
  await page.getByRole("region", { name: "Selected object" }).getByText("Harbor approach.mov", { exact: true }).waitFor();
  await openCategory('Notes');
  const notes = page.getByRole("region", { name: "notes", exact: true });
  await notes.getByRole("button", { name: "Edit", exact: true }).click();
  const attachmentPicker = notes.getByLabel("Imported copy", { exact: true });
  await attachmentPicker.selectOption({ label: "Navigation chart.pdf" });
  await notes.getByRole("button", { name: "Attach", exact: true }).click();
  await attachmentPicker.selectOption({ label: "Harbor approach.mov" });
  await notes.getByRole("button", { name: "Attach", exact: true }).click();
  await notes.getByRole("button", { name: "Save changes", exact: true }).click();

  await page.evaluate(() => {
    const key = "aerift.ios.objects.v1";
    const objects = JSON.parse(localStorage.getItem(key));
    const note = objects.find(item => item.kind === "note");
    if (Object.hasOwn(note, "attachmentIds")) throw new Error("The earlier build rejects this note record");
    note.text = "Note edited by an earlier build.";
    localStorage.setItem(key, JSON.stringify(objects));
  });
  await page.reload();
  await go("Workspace");
  await openCategory('Notes');
  await notes.getByText("2 attachments", { exact: true }).click();
  const savedNote = notes.locator(".ios-object-list > li").filter({ hasText: "Packing list" });
  await savedNote.getByText("Note edited by an earlier build.", { exact: true }).waitFor();
  const attachments = savedNote.locator("details li");
  await attachments.filter({ hasText: "Harbor approach.mov" }).getByRole("button", { name: "Preview" }).click();
  check((await attachments.allTextContents())[0].includes("Navigation chart.pdf"), "note attachments keep their order after restart");
  await savedNote.getByRole("button", { name: "Send note text", exact: true }).waitFor();
  await screenshot("note-attachments-390");
  await attachments.filter({ hasText: "Navigation chart.pdf" }).getByRole("button", { name: "Select for Rift" }).click();
  await page.locator(".ae-dock-file").getByText("Navigation chart.pdf", { exact: true }).waitFor();

  await go("Workspace");
  await openCategory("File Browser");
  await files.getByRole("button", { name: "Remove Navigation chart.pdf", exact: true }).click();
  await files.getByRole("button", { name: "Remove Navigation chart.pdf", exact: true }).waitFor({ state: "detached" });
  await openCategory('Notes');
  await notes.getByText("2 attachments", { exact: true }).click();
  await attachments.first().getByText("Imported copy unavailable", { exact: true }).waitFor();
  await notes.getByRole("button", { name: "Edit", exact: true }).click();
  await notes.getByRole("button", { name: "Detach Attachment 1", exact: true }).click();
  await notes.getByRole("button", { name: "Save changes", exact: true }).click();
  await notes.getByText("1 attachment", { exact: true }).waitFor();
  await openCategory('Web Browser');
  await page.evaluate(() => {
    window.__TAURI_INTERNALS__ = { invoke: (command, args) => {
      if (command !== "open_ios_browser" || args.url !== "https://example.test/start") {
        throw new Error("Unexpected browser request");
      }
      return Promise.resolve([{ url: "https://example.test/reached", title: "Harbor guide" }]);
    } };
  });
  await page.getByLabel("Address", { exact: true }).fill("example.test/start");
  await page.getByRole("button", { name: "Open page", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Link collected." }).waitFor();
  await page.reload();
  await go("Workspace");
  await openCategory('Web Browser');
  const browser = page.getByRole("region", { name: "browser", exact: true });
  const currentLink = browser.getByRole("listitem").filter({ hasText: "Harbor guide" });
  await currentLink.waitFor();
  await page.evaluate(() => {
    window.__TAURI_INTERNALS__ = { invoke: (command, args) => {
      if (command !== "stage_ios_text" || args.text !== "https://example.test/reached") {
        throw new Error("Unexpected link staging request");
      }
      return Promise.resolve({ name: args.name, sizeBytes: args.text.length, selectionId: "fixture-browser-link" });
    } };
  });
  await currentLink.getByRole("button", { name: "Send copy", exact: true }).click();
  await page.locator(".ae-dock-file").getByText("AeRift - Harbor guide.txt", { exact: true }).waitFor();
  return "Passed route focus, persistent selection, send, incoming consent, cancellation, theme and motion restart, collection copy staging, clipboard sharing and revocation, durable multi-item imports, note attachments, Browser link capture, saved Activity, and responsive bounds.";
}
