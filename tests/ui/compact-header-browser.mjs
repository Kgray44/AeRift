import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.AERIFT_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
const root = process.env.AERIFT_FIXTURE_URL ?? "http://127.0.0.1:4175";
const output = process.env.AERIFT_COMPACT_HEADER_EVIDENCE;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch(process.env.AERIFT_CHROMIUM_PATH
  ? { executablePath: process.env.AERIFT_CHROMIUM_PATH }
  : {});
const button = (scope, name) => scope.getByRole("button", { name, exact: true });

async function checkHeader(page, name) {
  const header = page.locator("header.ae-compact-header");
  const mark = header.getByRole("img", { name: "AeRift", exact: true });
  await mark.evaluate(el => el.decode());
  const [bar, markBox] = await Promise.all([header.boundingBox(), mark.boundingBox()]);
  assert.ok(bar && markBox && Math.abs(bar.x + bar.width / 2 - markBox.x - markBox.width / 2) <= 1);
  const status = header.getByRole("group", { name: "App status" });
  await status.getByRole("img", { name: "Camera off", exact: true }).waitFor();
  const connection = status.getByRole("img", { name: /paired connections? available$/ });
  await connection.waitFor();
  assert.equal(await connection.getAttribute("data-tone"), "active");
  assert.equal(await status.getByRole("img").count(), 2);
  assert.equal(await status.getByRole("button").count(), 0);
  assert.equal(await status.locator("[tabindex]").count(), 0);
  assert.equal(await header.locator(".ae-nav-brand,.ae-nav-tools").count(), 0);
  if (output) await page.screenshot({ path: join(output, name + ".png"), animations: "disabled" });
  return header;
}

try {
  const wide = await browser.newPage({ colorScheme: "dark", viewport: { width: 1024, height: 768 } });
  await wide.goto(root + "/desktop-visual.html?route=home&scheme=dark");
  const desktopHeader = await checkHeader(wide, "windows-header-dark");
  assert.equal(await button(desktopHeader, "Control Center").count(), 0);
  const nav = desktopHeader.getByRole("navigation", { name: "Desktop navigation" });
  const orbit = nav.getByRole("button", { name: /^Current destination:/ });
  if (await orbit.count()) await orbit.click();
  await button(nav, "Settings").click();
  await wide.getByRole("group", { name: "Settings categories" }).waitFor();
  await wide.close();

  for (const [platform, width, scheme] of [["ios", 390, "light"], ["android", 320, "dark"]]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: scheme, isMobile: true, hasTouch: true });
    await page.goto(root + "/mobile.html?friendsFixture=1&platform=" + platform);
    const header = await checkHeader(page, platform + "-header-" + scheme);
    assert.equal(await header.getByRole("button").count(), 0);
    const dock = page.getByRole("navigation", { name: "AeRift destinations" });
    const settings = button(dock, "Settings");
    assert.equal(await settings.count(), 1);
    const targets = await dock.getByRole("button").evaluateAll(els => els.map(el => [el.textContent, el.getBoundingClientRect().width, el.getBoundingClientRect().height]));
    assert.ok(targets.every(([, w, h]) => w >= 44 && h >= 44), JSON.stringify(targets));
    await settings.click();
    const dialog = page.getByRole("dialog", { name: "Control Center" });
    await dialog.waitFor();
    await button(dialog, "Close").click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await settings.evaluate(el => el === document.activeElement), true);
    await page.close();
  }
  console.log("Compact header verified: desktop Orbit, iOS Settings, narrow Android, logo decode/centering and truthful status.");
} finally {
  await browser.close();
}
