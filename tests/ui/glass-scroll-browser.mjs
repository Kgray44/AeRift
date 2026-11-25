import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const library = process.env.AERIFT_PLAYWRIGHT_MODULE;
const { chromium } = await import(library ? pathToFileURL(library).href : "playwright");
const browser = await chromium.launch({ executablePath: process.env.AERIFT_CHROMIUM });
const root = process.env.AERIFT_FIXTURE_URL ?? "http://127.0.0.1:4175";
const results = [];
try {
  for (const [platform, scheme] of [["windows", "dark"], ["ios", "light"], ["android", "dark"]]) {
    const desktop = platform === "windows";
    const page = await browser.newPage({ viewport: { width: desktop ? 1280 : 390, height: 780 },
      isMobile: !desktop, hasTouch: !desktop, colorScheme: scheme });
    await page.addInitScript(() => {
      const put = CanvasRenderingContext2D.prototype.putImageData;
      window.__sceneWrites = { atmosphere: 0, lenses: 0 };
      CanvasRenderingContext2D.prototype.putImageData = function (...args) {
        if (this.canvas.classList.contains("ae-glass-atmosphere")) window.__sceneWrites.atmosphere++;
        if (this.canvas.classList.contains("ae-glass-optics")) window.__sceneWrites.lenses++;
        return Reflect.apply(put, this, args);
      };
    });
    await page.goto(root + (desktop ? "/desktop-visual.html?route=workspace&scheme=" + scheme : "/mobile.html?platform=" + platform));
    const shell = page.locator('.ae-shell[data-ae-optics="ready"]');
    await shell.waitFor();
    // Exercise real document scrolling using additional synthetic room, rather
    // than relying on the currently selected route to have a specific height.
    await shell.evaluate(node => { node.style.minBlockSize = "250vh"; });
    await page.waitForTimeout(1000);
    const sample = await shell.evaluate(async node => {
      const scene = node.querySelector(".ae-glass-atmosphere");
      const sceneColor = () => Array.from(scene.getContext("2d").getImageData(1, 1, 3, 3).data).join(",");
      const before = { ...window.__sceneWrites };
      const pixels = sceneColor();
      const begin = window.scrollY;
      const seen = [];
      for (let i = 1; i <= 12; i++) {
        window.scrollTo(0, i * 18);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        seen.push({ y: window.scrollY, top: scene.getBoundingClientRect().top,
          pause: node.hasAttribute("data-ae-scrolling"),
          lensVisible: getComputedStyle(node.querySelector(".ae-glass-optics")).display !== "none",
          pixels: sceneColor(), writes: { ...window.__sceneWrites } });
      }
      return { before, pixels, begin, seen };
    });
    const movingFrames = sample.seen.filter(frame => frame.y > sample.begin && frame.pause);
    assert.ok(movingFrames.length >= 8, platform + " traverses the page with suspended optical raster");
    for (const frame of movingFrames) {
      assert.ok(Math.abs(frame.top) <= .5);
      assert.equal(frame.lensVisible, false);
      assert.equal(frame.pixels, sample.pixels);
      assert.deepEqual(frame.writes, sample.before, "no atmosphere or lens raster writes while scrolling");
    }
    await page.waitForFunction(() => !document.querySelector(".ae-shell").hasAttribute("data-ae-scrolling"));
    const after = await page.evaluate(() => window.__sceneWrites);
    assert.equal(after.atmosphere, sample.before.atmosphere, "settling resamples lenses without repainting the atmosphere");
    assert.equal(after.lenses - sample.before.lenses, 1, "one lens refresh after the scroll burst");
    results.push({ platform, scheme, sampledScrollingFrames: movingFrames.length,
      rasterWritesDuringScroll: 0, atmosphereWritesAfterScroll: 0, lensWritesAfterScroll: 1 });
    await page.close();
  }
  console.log(JSON.stringify(results));
} finally { await browser.close(); }
