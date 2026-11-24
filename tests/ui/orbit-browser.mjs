import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const playwright = process.env.AERIFT_ORBIT_PLAYWRIGHT;
const { chromium } = await import(playwright ? pathToFileURL(resolve(playwright)).href : "playwright");

const evidence = process.env.AERIFT_ORBIT_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.AERIFT_ORBIT_BROWSER });
const page = await browser.newPage({ viewport: { width: 1240, height: 760 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const base = process.env.AERIFT_ORBIT_URL ?? "http://127.0.0.1:47781/orbit.html";
const navigator = page.getByRole("navigation", { name: "Desktop navigation" });
const trigger = navigator.getByRole("button", { name: /Current destination/ });
const heading = page.locator("[data-orbit-focus]");
const surface = page.locator(".ae-orbit-surface");
const capture = name => evidence && page.screenshot({ path: evidence + "/" + name + ".jpg", type: "jpeg", quality: 87 });

async function expectRoute(route) {
  await heading.filter({ hasText: route }).waitFor();
  assert.equal(await heading.textContent(), route);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await heading.evaluate(node => node === document.activeElement), true);
}

try {
  await page.goto(base);
  await trigger.waitFor();
  await page.waitForFunction(() => document.querySelector(".ae-orbit")?.dataset.radial === "true");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await page.mouse.move(1110, 530);
  await capture("01-dark-rest");
  await trigger.click();
  assert.equal(await navigator.getByRole("button").count(), 6);
  await page.getByRole("button", { name: /^Devices/ }).hover();
  await capture("02-dark-expanded");
  const target = page.getByRole("button", { name: /^Devices/ });
  await target.evaluate(button => {
    const orb = button.querySelector(".ae-orbit-orb");
    window.orbitOrigin = orb.getBoundingClientRect().toJSON();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    queueMicrotask(() => {
      const section = document.querySelector(".ae-orbit-surface");
      for (const animation of section.getAnimations({ subtree: true })) animation.pause();
    });
  });
  await expectRoute("Devices");
  assert.equal(await surface.getAttribute("data-morphing"), "true");
  assert.match(await trigger.locator(".ae-orbit-current").textContent(), /^Home/);
  for (const time of [0, 80, 158, 236]) {
    await surface.evaluate((section, time) => {
      for (const animation of section.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = time;
      }
    }, time);
    if (time === 0) {
      const geometry = await surface.evaluate(section => ({
        skin: section.querySelector(".ae-orbit-skin").getBoundingClientRect().toJSON(),
        source: window.orbitOrigin,
      }));
      for (const property of ["x", "y", "width", "height"]) {
        assert(Math.abs(geometry.skin[property] - geometry.source[property]) < 2, property);
      }
    }
    await capture("03-morph-" + time);
  }
  await surface.evaluate(section => {
    for (const animation of section.getAnimations({ subtree: true })) animation.play();
  });
  await page.waitForFunction(() => !document.querySelector(".ae-orbit-surface")?.dataset.morphing);
  assert.match(await trigger.locator(".ae-orbit-current").textContent(), /^Devices/);
  await capture("04-dark-settled");

  await page.keyboard.press("Alt+o");
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(await navigator.getByRole("button", { name: "Home" }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press("ArrowDown");
  assert.equal(await navigator.getByRole("button", { name: "Workspace" }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
  await trigger.click();
  await page.locator(".orbit-lab-online").click();
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");

  await page.keyboard.press("Alt+o");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expectRoute("Settings");
  assert.equal(await surface.getAttribute("data-morphing"), null);
  await page.keyboard.press("Alt+o");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expectRoute("Rift");
  await page.setViewportSize({ width: 710, height: 505 });
  await page.waitForFunction(() => !document.querySelector(".ae-orbit-surface")?.dataset.morphing);
  await page.getByLabel("Selected file").fill("Preserved.pdf");
  await heading.focus();
  await page.keyboard.press("Alt+o");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expectRoute("Home");
  await page.getByRole("button", { name: "Open Rift" }).click();
  await expectRoute("Rift");
  assert.equal(await page.getByLabel("Selected file").inputValue(), "Preserved.pdf");

  await page.setViewportSize({ width: 940, height: 620 });
  await page.goto(base + "?scheme=light&mode=simplified");
  await trigger.click();
  assert.equal(await navigator.getByRole("button").count(), 5);
  assert.equal(await navigator.getByRole("button", { name: "Workspace" }).count(), 0);
  await page.waitForFunction(() => document.querySelector(".ae-orbit")?.dataset.radial === "true");
  await navigator.getByRole("button", { name: "Rift" }).hover();
  await capture("05-light-expanded");
  await page.setViewportSize({ width: 420, height: 220 });
  await page.waitForFunction(() => document.querySelector(".ae-orbit")?.dataset.radial === "false");
  assert.equal(await navigator.getAttribute("data-radial"), "false");
  await capture("06-compact-fallback");
  await navigator.getByRole("button", { name: /^Activity/ }).click();
  await expectRoute("Activity");

  await page.setViewportSize({ width: 940, height: 620 });
  await page.goto(base + "?reduced&scheme=light");
  await trigger.waitFor();
  await page.keyboard.press("Alt+o");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expectRoute("Settings");
  assert.equal(await surface.getAttribute("data-morphing"), null);
  await capture("07-reduced-motion");
  await page.getByRole("checkbox", { name: "Conventional", exact: true }).check();
  const conventional = navigator.getByRole("button", { name: "Home" });
  await conventional.click();
  assert.equal(await conventional.getAttribute("aria-current"), "page");
  await page.goto(base);
  await trigger.waitFor();
  await page.getByRole("checkbox", { name: "Inspect morph" }).check();
  await heading.focus();
  await page.keyboard.press("Alt+o");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expectRoute("Settings");
  await page.getByRole("slider", { name: "Morph frame" }).fill("80");
  assert.equal(await surface.evaluate(section => section.getAnimations()[0].currentTime), 80);
  await page.getByRole("checkbox", { name: "Inspect morph" }).uncheck();
  await page.waitForFunction(() => !document.querySelector(".ae-orbit-surface")?.dataset.morphing);

  await page.getByLabel("Orbit shortcut").selectOption("alt-shift-o");
  await heading.focus();
  await page.keyboard.press("Alt+o");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await page.keyboard.press("Alt+Shift+o");
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  await page.keyboard.press("Escape");

  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light", forcedColors: "active" });
  await page.goto(base);
  await trigger.waitFor();
  await page.keyboard.press("Alt+o");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expectRoute("Settings");
  assert.equal(await surface.getAttribute("data-morphing"), null);
  assert.equal(await page.locator(".ae-orbit-trigger .ae-orbit-orb").evaluate(orb => getComputedStyle(orb).backdropFilter), "none");
  await trigger.hover({ position: { x: 5, y: 9 } });
  assert.equal(await page.locator(".ae-orbit-trigger .ae-orbit-orb").evaluate(orb => getComputedStyle(orb).translate), "none");
  assert.deepEqual(errors, []);
  console.log("PASS Chromium: geometry continuity from actual orb bounds, both modes and themes, keyboard, Escape, outside click, rapid reroute, resize, retained fixture state, reduced motion, conventional routing.");
} finally {
  await browser.close();
}
