import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const library = process.env.AERIFT_FRIENDS_PLAYWRIGHT;
const { chromium } = await import(library ? pathToFileURL(library).href : "playwright");
const browser = await chromium.launch({ executablePath: process.env.AERIFT_FRIENDS_BROWSER });
const root = process.env.AERIFT_FRIENDS_URL ?? "http://127.0.0.1:47807";
const observations = [];
try {
  for (const [platform, scheme, dir] of [["ios", "light", "ltr"], ["android", "dark", "rtl"]]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: scheme, isMobile: true, hasTouch: true });
    await page.goto(root + "/mobile.html?friendsFixture=1&platform=" + platform);
    await page.evaluate(dir => { document.documentElement.dir = dir; }, dir);
    await page.getByRole("button", { name: "Friends", exact: true }).tap();
    const list = page.locator(".ae-friends-list");
    const live = page.locator(".ae-mobile-presence-pane[data-present=true]");
    const exit = page.locator(".ae-mobile-presence-pane[data-present=false]");
    const a = list.getByRole("button", { name: "Test contact A" });
    await a.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Test contact A", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Test contact A");
    assert.equal(await list.getByRole("button", { name: "Test contact B" }).count(), 0);
    await page.waitForFunction(() => {
      const old = document.querySelector(".ae-mobile-presence-pane[data-present=false]");
      const current = document.querySelector(".ae-mobile-presence-pane[data-present=true]");
      return old?.inert && old.getAttribute("aria-hidden") === "true" && current &&
        new DOMMatrixReadOnly(getComputedStyle(current).transform).m41 !== 0;
    }, undefined, { timeout: 3000 });
    const x = await live.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
    assert.ok(dir === "ltr" ? x >= 0 : x <= 0, "forward direction mirrors in RTL");
    await exit.waitFor({ state: "detached", timeout: 1500 });
    const back = live.getByRole("button", { name: "Back to friends", exact: true });
    await back.press("Enter");
    await a.waitFor();
    assert.equal(await a.evaluate(el => document.activeElement === el), true);
    // Reverse immediately via keyboard before the prior visual exit settles.
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Test contact A", exact: true }).waitFor();
    assert.equal(await live.count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Test contact A");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await exit.waitFor({ state: "detached", timeout: 750 });
    assert.equal(await live.evaluate(el => getComputedStyle(el).transform), "none");
    await back.press("Enter");
    await a.waitFor();
    assert.equal(await a.evaluate(el => document.activeElement === el), true);
    await exit.waitFor({ state: "detached", timeout: 750 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await live.evaluate(el => getComputedStyle(el).transform), "none");
    const settingsButton = page.getByRole("button", { name: "Control Center", exact: true });
    await settingsButton.tap();
    const settings = page.getByRole("dialog", { name: "Control Center" });
    await settings.getByLabel("Reduce motion", { exact: true }).check();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await settings.waitFor({ state: "hidden" });
    await a.press("Enter");
    await page.getByRole("heading", { name: "Test contact A", exact: true }).waitFor();
    await exit.waitFor({ state: "detached", timeout: 750 });
    assert.equal(await live.evaluate(el => getComputedStyle(el).transform), "none");
    observations.push({ platform, scheme, dir, sampleEnteringX: x, singleInteractivePane: true, focusRestored: true, reducedNoReplay: true });
    await page.close();
  }
  console.log(JSON.stringify(observations));
} finally { await browser.close(); }
