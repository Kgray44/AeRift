import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.AERIFT_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
const browser = await chromium.launch(process.env.AERIFT_CHROMIUM_PATH
  ? { executablePath: process.env.AERIFT_CHROMIUM_PATH }
  : {});
const target = process.env.AERIFT_DESKTOP_URL ?? "http://127.0.0.1:1420";
const evidence = process.env.AERIFT_DESKTOP_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    colorScheme: "dark",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36",
  });
  await page.addInitScript(() => {
    let callback = 0;
    const calls = [];
    window.isTauri = true;
    window.controlCenterCalls = calls;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback,
      unregisterCallback() {},
      async invoke(command, args) {
        calls.push({ command, args });
        switch (command) {
          case "windows_remote_mode": return { current: "nearby", nextEndpoint: null, restartNeeded: false };
          case "watch_app":
            queueMicrotask(() => args.updates.onmessage({ version: 1, devices: [], transfers: [], pendingPairing: [] }));
            return "browser-test";
          case "get_receive_folder": return { active: "C:\\Test\\Receipts", next: null };
          case "choose_receive_folder": return { active: "C:\\Test\\Receipts", next: "C:\\Test\\Next" };
          case "watch_desktop_ambient": return true;
          case "desktop_startup_enabled":
          case "desktop_explorer_enabled": return false;
          case "set_desktop_explorer": return args.enabled;
          case "watch_file_selection":
          case "set_desktop_ambient":
          case "update_desktop_ambient": return null;
          default: throw new Error("Test did not provide " + command);
        }
      },
    };
  });
  await page.goto(target);
  await page.getByRole("button", { name: "Control Center", exact: true }).click();
  const categories = page.getByRole("group", { name: "Settings categories" });
  const category = name => categories.getByRole("button", { name, exact: true });
  const snapshot = async name => {
    if (evidence) await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled" });
  };
  await category("General").waitFor();
  assert.equal(await category("General").getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByLabel("Camera activation shortcut").isVisible(), false);
  await snapshot("control-center-desktop");
  await category("Gestures").focus();
  await page.keyboard.press("Enter");
  assert.equal(await category("Gestures").getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByLabel("Camera activation shortcut").isVisible(), true);
  assert.equal(await page.getByLabel("Window mode").isVisible(), false);

  await category("Transfers").click();
  const folder = page.getByRole("button", { name: "Choose receive folder", exact: true });
  assert.equal(await folder.isVisible(), true);
  const vpn = page.getByText("Remote transfers over a private VPN", { exact: true });
  const endpoint = page.getByLabel("This computer’s VPN IPv4 address and port");
  assert.equal(await endpoint.isVisible(), false);
  await vpn.click();
  await endpoint.fill("100.64.0.10:48888");
  const apply = page.getByRole("button", { name: "Use Remote after reopening" });
  assert.equal(await apply.isEnabled(), false, "typing a route never grants authorization");
  const consent = page.getByRole("checkbox", { name: /I authorize this private VPN address/ });
  await consent.check();
  assert.equal(await apply.isEnabled(), true);
  await endpoint.fill("100.64.0.11:48888");
  assert.equal(await consent.isChecked(), false, "editing the endpoint clears consent");
  assert.equal(await apply.isEnabled(), false);
  assert.equal(await page.evaluate(() => window.controlCenterCalls.some(call => call.command === "windows_set_remote_mode")), false);

  await page.setViewportSize({ width: 620, height: 780 });
  await vpn.click();
  assert.equal(await endpoint.isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await snapshot("control-center-compact");
  console.log("Desktop entry: Control Center categories, keyboard focus, responsive layout, and private VPN consent passed.");
} finally {
  await browser.close();
}
