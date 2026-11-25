import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const root = process.env.AERIFT_FIXTURE_URL ?? "http://127.0.0.1:4175";
const { chromium } = await import(process.env.AERIFT_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.AERIFT_PLAYWRIGHT_MODULE).href : "playwright");
const browser = await chromium.launch({ executablePath: process.env.AERIFT_CHROMIUM });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const expected = "https://saved.safe-browser.invalid/docs?token=redacted-from-history#bookmark";
try {
  for (const platform of ["desktop", "ios", "android"]) {
    const page = await browser.newPage({ viewport: { width: platform === "desktop" ? 1280 : 390, height: 844 } });
    page.setDefaultTimeout(7000);
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(root).origin ? route.continue() : route.abort());
    await page.goto(root + (platform === "desktop" ? "/desktop-visual.html?route=workspace" : "/mobile.html?platform=" + platform) + "&safeBrowserFixture=1");
    if (platform !== "desktop")
      await button(page.getByRole("navigation", { name: "AeRift destinations" }), "Workspace").click();
    await button(page, "Web Browser").click();
    const address = page.getByRole("textbox", { name: "Address or search terms" });
    const query = page.getByRole("searchbox", { name: "Find saved links" });
    const history = page.getByRole("checkbox", { name: "Remember addresses opened in AeRift" });
    assert.equal(await history.isChecked(), false);
    await address.fill("natural language query");
    assert.equal(await button(page, "Save address").isDisabled(), true);
    assert.equal(await button(page, "Save address").innerText(), "");
    assert.equal(await button(page, "Save address").getAttribute("title"), "Save address");
    assert.equal(await button(page, "Save address").locator("svg").count(), 1);
    await address.fill(expected);
    await button(page, "Save address").click();
    await page.getByText("Link saved to Workspace.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("aerift.safeBrowserTest.lastOpen")), null);
    await button(page, "Save address").click();
    await page.getByText("This link is already saved.", { exact: true }).waitFor();
    await query.fill("redacted-from-history");
    await page.getByText("No saved links match.", { exact: true }).waitFor();
    await query.fill("saved.safe-browser");
    assert.equal(await page.getByText("No saved links match.", { exact: true }).count(), 0);
    await history.check();
    await button(page, platform === "desktop" ? "Open in system browser" : "Open page").click();
    await page.waitForFunction(() => sessionStorage.getItem("aerift.safeBrowserTest.lastOpen"));
    const open = await page.evaluate(() => JSON.parse(sessionStorage.getItem("aerift.safeBrowserTest.lastOpen")));
    assert.equal(open.cmd, platform === "desktop" ? "open_workspace_url" : `open_${platform}_browser`);
    assert.equal(open.args.url, expected);
    await page.getByText("Recent pages", { exact: true }).waitFor();
    assert.equal(await button(page, "https://saved.safe-browser.invalid/docs").count(), 1);
    assert.equal(await button(page, expected).count(), 0);
    await page.close();
  }
  console.log("Saved-link direct save, privacy filter, and scoped opener passed on Desktop, iOS and Android fixtures.");
} finally { await browser.close(); }
