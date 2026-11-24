// Isolated synthetic rendering; does not inspect, launch or input into a real desktop app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const vite = fileURLToPath(new URL("../../node_modules/vite/bin/vite.js", import.meta.url));
const cwd = fileURLToPath(new URL("../../apps/aerift/", import.meta.url));
const port = 1431;
const address = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd, stdio: ["ignore", "ignore", "inherit"] });
let browser;
const pause = timeout => new Promise(resolve => setTimeout(resolve, timeout));

try {
  for (let attempts = 0;; attempts++) {
    assert.ok(attempts < 50 && server.exitCode === null, "Disposably hosted Vite must start");
    if ((await fetch(address, { signal: AbortSignal.timeout(1000) }).catch(() => undefined))?.ok) break;
    await pause(100);
  }
  browser = await chromium.launch();
  const evidence = process.env.AERIFT_SYNTHETIC_OVERLAY_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const [scheme, motion] of [["dark", "no-preference"], ["light", "no-preference"], ["dark", "reduce"]]) {
    const context = await browser.newContext({
      viewport: { width: 332, height: 148 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36",
      colorScheme: scheme, reducedMotion: motion,
    });
    await context.addInitScript(() => {
      const calls = [];
      let subscriber;
      let counter = 0;
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = {
        transformCallback() { return ++counter; }, unregisterCallback() {},
        invoke(command, args) {
          calls.push(command);
          if (command !== "desktop_transfer_preview") throw Error("Unexpected side-effect IPC");
          subscriber = args.updates;
          return Promise.resolve();
        },
      };
      window.fixture = {
        push(event) { subscriber.onmessage(event); },
        calls,
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${address}/?surface=desktop-preview`);
    const send = frame => page.evaluate(frame => window.fixture.push(frame), frame);
    await page.waitForFunction(() => window.fixture?.calls.length === 1);
    assert.equal(await page.getByRole("status").count(), 0, "idle mounts neither overlay nor animator");
    assert.equal(await page.locator("canvas").count(), 0);
    await send({ version: 1, interaction: "cafefade", sequence: 1, phase: "hand" });
    await page.getByText("Ready to pick up").waitFor();
    await send({ version: 1, interaction: "cafefade", sequence: 2, phase: "context", count: 3 });
    await page.getByText("3 objects", { exact: true }).waitFor();
    await send({ version: 1, interaction: "cafefade", sequence: 3, phase: "held" });
    await page.getByText("Carrying", { exact: true }).waitFor();
    const silhouette = page.locator("#ambient-liquid-shape");
    const initial = await silhouette.getAttribute("d");
    await page.waitForTimeout(125);
    const next = await silhouette.getAttribute("d");
    assert.equal(next === initial, motion === "reduce", "only reduced motion freezes the silhouette");
    assert.equal(await page.locator(".ae-ambient-overlay").evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
    assert.equal(await page.locator(".ae-ambient-overlay .ae-surface").count(), 0, "no notification panel");
    assert.equal(await page.locator(".ae-theme").getAttribute("data-appearance"), scheme);
    if (motion !== "reduce") {
      const stats = await page.evaluate(() => new Promise(resolve => {
        const gaps = [];
        let last;
        function sample(now) {
          if (last !== undefined) gaps.push(now - last);
          last = now;
          if (gaps.length < 45) return requestAnimationFrame(sample);
          gaps.sort((a, b) => a - b);
          resolve({ frames: gaps.length, medianMs: gaps[22], p95Ms: gaps[42] });
        }
        requestAnimationFrame(sample);
      }));
      console.log(`Synthetic ${scheme} overlay browser frame intervals: ${JSON.stringify(stats)}`);
      assert.ok(stats.frames === 45 && stats.medianMs > 0);
      const clear = await page.screenshot({ omitBackground: true, ...(evidence ? {
        path: join(evidence, `synthetic-carry-${scheme}.png`),
      } : {}) });
      const centerAlpha = await page.evaluate(async encoded => {
        const bitmap = new Image();
        bitmap.src = "data:image/png;base64," + encoded;
        await bitmap.decode();
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(166, 51, 1, 1).data[3];
      }, clear.toString("base64"));
      assert.ok(centerAlpha < 48, `expected mostly transparent center, alpha=${centerAlpha}`);
      if (evidence) {
        await page.evaluate(() => {
          const backdrop = document.createElement("div");
          backdrop.className = "fixture-backdrop";
          backdrop.textContent = "Natural desk / file selection / Ambient Rift";
          backdrop.style.cssText = "position:fixed;inset:0;z-index:-1;font:16px monospace;color:#282a37;display:grid;place-items:center;background:repeating-linear-gradient(127deg,#edf0ff 0 13px,#d8def1 13px 26px);";
          document.body.prepend(backdrop);
        });
        await page.screenshot({ path: join(evidence, `synthetic-pattern-${scheme}.png`) });
      }
    }
    await send({ version: 1, interaction: "cafefade", sequence: 4, phase: "receiving", progress: 1 });
    await page.locator("progress[value='1']").waitFor();
    await send({ version: 1, interaction: "cafefade", sequence: 5, phase: "completed" });
    assert.equal(await page.getByText("Delivery verified").count(), 0);
    await send({ version: 1, interaction: "cafefade", sequence: 6, phase: "completed", verified: true });
    await page.getByText("Delivery verified").waitFor();
    await page.getByRole("status").waitFor({ state: "detached" });
    assert.equal(await page.locator("canvas").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ["desktop_transfer_preview"]);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Glass overlay: light/dark, active animation, reduced motion, verified terminal, and invisible idle.");
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) server.kill();
}
