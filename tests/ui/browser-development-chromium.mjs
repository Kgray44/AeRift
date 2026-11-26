import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const root = process.env.AERIFT_FIXTURE_URL ?? "http://127.0.0.1:4175";
const { chromium } = await import(process.env.AERIFT_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.AERIFT_PLAYWRIGHT_MODULE).href : "playwright");
const browser = await chromium.launch({ executablePath: process.env.AERIFT_CHROMIUM });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6000);
  const local = "/desktop-visual.html?developmentFixture=1&route=";
  await page.route("**/*", request => new URL(request.request().url()).origin === new URL(root).origin ? request.continue() : request.abort());
  const settings = () => page.goto(root + local + "settings");
  async function development() {
    const group = page.getByRole("group", { name: "Settings categories" });
    await group.getByRole("button", { name: "Development", exact: true }).click();
    return page.getByRole("checkbox", { name: "Embedded Websites", exact: true });
  }
  await settings();
  assert.equal(await page.getByRole("checkbox", { name: "Embedded Websites", exact: true }).count(), 0);
  let toggle = await development();
  assert.equal(await toggle.isChecked(), false);
  await toggle.check();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("aerift.settings.v1")).embeddedWebsitesRequested === true);
  await settings();
  toggle = await development();
  assert.equal(await toggle.isChecked(), true);
  await page.goto(root + local + "workspace");
  await page.getByRole("button", { name: "Web Browser", exact: true }).click();
  await page.getByText("Embedded Websites is requested, but unavailable in this build. Opens pages in your default browser.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Open in system browser", exact: true }).count(), 1);
  assert.equal(await page.locator("iframe").count(), 0);
  await settings();
  toggle = await development();
  await toggle.uncheck();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("aerift.settings.v1")).embeddedWebsitesRequested === false);
  console.log("Development preference defaults off, persists, and does not override the system browser fallback.");
} finally { await browser.close(); }
