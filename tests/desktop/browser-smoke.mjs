import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const playwright = process.env.AERIFT_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.AERIFT_PLAYWRIGHT_MODULE).href)
  : await import("playwright");
const browser = await playwright.chromium.launch(process.env.AERIFT_CHROMIUM_PATH
  ? { executablePath: process.env.AERIFT_CHROMIUM_PATH }
  : { channel: process.env.AERIFT_BROWSER_CHANNEL ?? "chrome" });
const evidence = process.env.AERIFT_DESKTOP_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });

const fixture = {
  device: { id: "test-device", name: "Studio laptop", platform: "windows", paired: true, online: true },
  transfer: {
    id: "test-transfer", deviceId: "test-device", direction: "outgoing", state: "transferring",
    file: { name: "Field recording.wav", sizeBytes: 1000 }, bytesTransferred: 430,
  },
};

async function capture(page, name) {
  if (!evidence) return;
  const viewport = page.viewportSize();
  const compact = name === "light-compact-workspace" || name === "dark-production-rift";
  const height = compact ? await page.evaluate(() => document.documentElement.scrollHeight) : viewport.height;
  if (compact) await page.setViewportSize({ width: viewport.width, height });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled", scale: "css",
    clip: { x: 0, y: 0, width: viewport.width, height } });
  if (compact) await page.setViewportSize(viewport);
}

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, colorScheme: "dark",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36",
  });

  await context.addInitScript(({ device, transfer }) => {
    const calls = [];
    let onDrop;
    let openTrayRoute;
    let startedAtSignIn = false;
    let explorerAction = false;
    let overlayUpdates;
    let preview = { version: 1, interaction: "cafefade", phase: "transferring", sequence: 2, progress: .43 };
    const publish = (channel, event) => queueMicrotask(() => channel.onmessage(event));
    const nextId = (() => { let current = 0; return () => ++current; })();

    Object.defineProperty(navigator, "clipboard", {
      value: { readText: async () => "A deliberately captured test snippet" },
    });
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      transformCallback: nextId,
      unregisterCallback() {},
      async invoke(channel, args) {
        calls.push({ channel, args });
        switch (channel) {
          case "watch_app":
            publish(args.updates, { version: 1, devices: [device], transfers: [transfer], pendingPairing: [] });
            return "mock-session";
          case "get_receive_folder": return { active: "C:\\Users\\User\\Downloads", next: null };
          case "watch_file_selection": onDrop = args.updates; break;
          case "select_app_file":
            publish(onDrop, { kind: "changed", selection: {
              name: "Local specimen.txt", sizeBytes: 12, selectionId: "picker-selection",
            } });
            return { name: "Local specimen.txt", sizeBytes: 12, selectionId: "picker-selection" };
          case "watch_desktop_ambient": openTrayRoute = args.route; return true;
          case "desktop_explorer_enabled": return explorerAction;
          case "set_desktop_explorer": explorerAction = args.enabled; return explorerAction;
          case "desktop_startup_enabled": return startedAtSignIn;
          case "set_desktop_startup": startedAtSignIn = args.enabled; return startedAtSignIn;
          case "pair_app_peer": throw new Error("Pairing requires physical verification");
          case "transfer_app_file": throw new Error("File delivery requires physical verification");
          case "desktop_transfer_preview":
            overlayUpdates = args.updates;
            publish(overlayUpdates, preview);
            return;
          case "open_workspace_url":
          case "set_desktop_ambient":
          case "set_desktop_shortcut":
          case "update_desktop_ambient":
          case "unwatch_app": break;
          default: throw new Error(`Unexpected IPC ${channel}`);
        }
      },
    };
    window.desktopFixture = {
      count: name => calls.filter(call => call.channel === name).length,
      last: name => calls.findLast(call => call.channel === name)?.args,
      tray(route) { publish(openTrayRoute, route); },
      updatePreview(next) { publish(overlayUpdates, { ...preview, ...next }); },
    };

    const key = "aerift.settings.v1";
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, JSON.stringify({ appearance: { scheme: "dark", motion: "reduce" }, cameraShortcut: "v" }));
    }
  }, fixture);

  const page = await context.newPage();
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(process.env.AERIFT_DESKTOP_URL ?? "http://127.0.0.1:1420");
  const destination = label => page.getByRole("heading", { name: label, exact: true, level: 2 });
  const slot = page.getByRole("navigation", { name: "Desktop navigation" });
  const openOrbit = async label => {
    await page.keyboard.press("Alt+o");
    await slot.getByRole("button", { name: label, exact: true }).press("Enter");
    await destination(label).waitFor();
  };

  await destination("Home").waitFor();
  await page.getByText(fixture.device.name, { exact: true }).filter({ visible: true }).waitFor();
  await page.keyboard.press("Alt+o");
  await page.getByRole("button", { name: "Settings", exact: true }).last().waitFor();
  assert.equal(await page.getByRole("button", { name: "Workspace", exact: true }).count(), 0);
  await capture(page, "dark-simplified-orbit");
  await page.keyboard.press("Escape");
  const baselineWatchCount = await page.evaluate(() => window.desktopFixture.count("watch_app"));
  assert.ok(baselineWatchCount > 0);

  await page.getByRole("button", { name: "Open the Rift", exact: true }).click();
  await destination("Rift").waitFor();
  await page.getByRole("button", { name: /^Choose (another )?file$/ }).click();
  await page.getByText("Local specimen.txt", { exact: true }).filter({ visible: true }).waitFor();
  await capture(page, "dark-production-rift");
  assert.equal(await page.getByRole("button", { name: "Use camera gesture" }).count(), 0);
  await openOrbit("Settings");
  assert.equal(await destination("Settings").evaluate(node => node === document.activeElement), true);
  assert.equal(await page.getByLabel("Camera activation shortcut").inputValue(), "v");
  await page.getByLabel("Window mode").selectOption("full");
  await page.getByRole("combobox", { name: /^Navigation/ }).selectOption("conventional");
  await page.getByLabel("Keep AeRift in the Windows notification area").check();
  await page.waitForFunction(() => window.desktopFixture.last("set_desktop_ambient")?.enabled === true);
  await page.getByRole("combobox", { name: /^Windows shortcut to open the Rift/ }).selectOption("alt-shift-r");
  await page.waitForFunction(() => window.desktopFixture.last("set_desktop_shortcut")?.choice === "alt-shift-r");
  await page.getByLabel("Open AeRift when I sign in").check();
  await page.getByLabel("Allow manual clipboard capture").check();
  await page.getByLabel("Add Stage in AeRift").check();
  await page.waitForFunction(() => window.desktopFixture.last("set_desktop_explorer")?.enabled === true);
  await page.waitForFunction(() => window.desktopFixture.last("set_desktop_startup")?.enabled === true);

  const nav = label => slot.getByRole("button", { name: label, exact: true });
  await nav("Workspace").click();
  await destination("Workspace").waitFor();
  async function openCategory(name) {
    const back = page.getByRole("button", { name: "Back to Workspace", exact: true });
    if (await back.isVisible()) await back.click();
    await page.getByRole("button", { name, exact: true }).click();
    assert.equal(await page.getByRole("heading", { name, exact: true, level: 3 }).evaluate(el => el === document.activeElement), true);
    const disclosure = page.locator(".aerift-workspace-create:not([open]) summary").first();
    if (["Notes","Web Browser"].includes(name) && await disclosure.isVisible()) await disclosure.click();
  }
  await capture(page, "dark-workspace-library");
  await openCategory('Notes');
  await page.getByLabel("Title").fill("Expedition notes");
  await page.getByLabel("Note", { exact: true }).fill("Review the field recording.");
  await page.getByRole("button", { name: "Add note" }).click();
  await page.getByText("Review the field recording.").waitFor();
  await page.getByRole("checkbox", { name: "Expedition notes" }).check();
  await openCategory('File Browser');
  await page.getByLabel("Import files").setInputFiles({
    name: "sample.txt", mimeType: "text/plain", buffer: Buffer.from("Example text"),
  });
  await page.getByRole("checkbox", { name: "sample.txt" }).check();
  await openCategory('Collections');
  await page.getByLabel("Name", { exact: true }).fill("Expedition");
  await page.getByRole("button", { name: "Create collection" }).click();
  await page.getByText("Expedition", { exact: true }).waitFor();
  await capture(page, "dark-full-workspace");

  await openCategory('Images & Videos');
  await page.getByLabel("Import photos and videos").setInputFiles({
    name: "sample.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXNYAAAAASUVORK5CYII=", "base64"),
  });
  await page.getByRole("button", { name: "Actions for sample.png", exact: true }).click();
  await page.getByRole("button", { name: "File details", exact: true }).click();
  const importedPhoto = page.getByRole("img", { name: "sample.png" });
  await importedPhoto.waitFor();
  const imageHandle = await importedPhoto.elementHandle();
  await page.waitForFunction(img => img.complete && img.naturalWidth > 0, imageHandle);

  await openCategory('Web Browser');
  await page.getByLabel("Title").fill("Project reference");
  await page.getByLabel("Web address").fill("https://example.test/");
  await page.getByRole("button", { name: "Save link" }).click();
  await page.getByRole("button", { name: "Actions for Project reference" }).click();
  await page.getByRole("button", { name: "Open in browser" }).click();
  assert.equal(await page.evaluate(() => window.desktopFixture.last("open_workspace_url").url), "https://example.test/");

  await openCategory('Clipboard');
  await page.getByRole("button", { name: "Capture clipboard text" }).click();
  await page.getByText("A deliberately captured test snippet", { exact: true }).waitFor();

  await page.evaluate(() => window.desktopFixture.tray("activity"));
  await destination("Activity").waitFor();
  assert.equal(await page.getByRole("progressbar", { name: fixture.transfer.file.name, exact: true }).getAttribute("aria-valuenow"), "43");
  await page.getByRole("combobox", { name: /^Show/ }).selectOption("finished");
  await page.getByText("No transfers match this view.").waitFor();
  await page.getByRole("combobox", { name: /^Show/ }).selectOption("all");
  await page.getByText("Outgoing · Studio laptop", { exact: true }).filter({ visible: true }).waitFor();

  await page.getByRole("button", { name: "Control Center" }).click();
  await destination("Settings").waitFor();
  await page.getByLabel("Window mode").selectOption("simplified");
  assert.equal(await nav("Workspace").count(), 0);
  await nav("Rift").click();
  await page.getByText("Local specimen.txt", { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await page.evaluate(() => window.desktopFixture.count("watch_app")), baselineWatchCount);
  assert.equal(await page.evaluate(() => window.desktopFixture.count("transfer_app_file")), 0);

  await nav("Settings").click();
  await page.getByLabel("Window mode").selectOption("full");
  await page.getByRole("checkbox", { name: "Notes", exact: true }).uncheck();
  await nav("Workspace").click();
  assert.equal(await page.getByRole("button", { name: "Notes", exact: true }).count(), 0);
  await nav("Settings").click();
  await page.getByRole("checkbox", { name: "Notes", exact: true }).check();
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await nav("Workspace").click();
  await page.reload();
  await destination("Workspace").waitFor();
  await openCategory('Notes');
  await page.getByText("Review the field recording.").waitFor();
  await page.setViewportSize({ width: 500, height: 720 });
  await capture(page, "light-compact-workspace");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const preview = await context.newPage();
  await preview.setViewportSize({ width: 332, height: 148 });
  await preview.goto((process.env.AERIFT_DESKTOP_URL ?? "http://127.0.0.1:1420") + "?surface=desktop-preview");
  await preview.getByText("Sending", { exact: true }).waitFor();
  assert.equal(await preview.getByRole("progressbar").getAttribute("value"), "0.43");
  const initialSilhouette = await preview.locator("#ambient-liquid-shape").getAttribute("d");
  await preview.waitForTimeout(125);
  assert.equal(await preview.locator("#ambient-liquid-shape").getAttribute("d"), initialSilhouette);
  await capture(preview, "light-ambient-preview");
  await preview.evaluate(() => window.desktopFixture.updatePreview({ sequence: 4, phase: "transferring", progress: 1 }));
  await preview.locator("progress[value='1']").waitFor();
  await preview.evaluate(() => window.desktopFixture.updatePreview({ sequence: 5, phase: "completed", progress: undefined }));
  assert.equal(await preview.getByText("Delivery verified", { exact: true }).count(), 0);
  await preview.evaluate(() => window.desktopFixture.updatePreview({ sequence: 6, phase: "completed", progress: undefined, verified: true }));
  await preview.getByText("Delivery verified", { exact: true }).waitFor();
  await preview.getByRole("status").waitFor({ state: "detached" });
  assert.equal(await preview.evaluate(() => window.desktopFixture.count("desktop_transfer_preview")), 1);
  assert.deepEqual(errors, []);
  console.log("PASS: desktop shell, mode and module persistence, simulated native selection and progress, keyboard focus, tray commands, compact width.");
} finally {
  await browser.close();
}
