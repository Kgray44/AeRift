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
  await page.getByRole("button", { name: "Photos and videos", exact: true }).click();
  await page.getByRole("button", { name: "Choose media", exact: true }).click();
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
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Packing list");
  await page.getByLabel("Note", { exact: true }).fill("Charts and camera");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByText("Packing list", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Collections", exact: true }).click();
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
  await page.getByRole("button", { name: "Collections", exact: true }).click();
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
  await page.getByRole("button", { name: "Clipboard", exact: true }).click();
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
  await page.getByRole("button", { name: "Clipboard", exact: true }).click();
  check(await page.getByText("Dock code", { exact: true }).count() === 0, "explicit clear removed saved pin");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
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
  await page.getByRole("button", { name: "Collections", exact: true }).click();
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
  return "Passed route focus, persistent selection, send, incoming consent, cancellation, theme and motion restart, clipboard opt-in, collection persistence and copy staging, saved Activity, consent reading order, and phone/rotation/tablet bounds.";
}
