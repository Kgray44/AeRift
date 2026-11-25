import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const runtime = process.env.AERIFT_PLAYWRIGHT_MODULE;
const { chromium } = await import(runtime ? pathToFileURL(runtime).href : "playwright");
const origin = process.env.AERIFT_FIXTURE_URL ?? "http://127.0.0.1:4175";
const browser = await chromium.launch(process.env.AERIFT_CHROMIUM_PATH
  ? { executablePath: process.env.AERIFT_CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const literal = "<strong>This is plain text</strong>\nhttps://example.test/";
  await page.addInitScript(text => {
    window.previewCalls = [];
    window.__TAURI_INTERNALS__ = { invoke: (name, args) => {
      if (name !== "preview_ios_received_text") return Promise.reject({ code: "invalid_request" });
      window.previewCalls.push([name, args]);
      if (window.previewCalls.length === 1)
        return new Promise(resolve => { window.releasePreview = () => resolve("Discard the stale response"); });
      return Promise.resolve(text);
    } };
  }, literal);
  await page.goto(origin + "/mobile.html?receivedTextFixture=1");
  const dock = page.getByRole("navigation", { name: "AeRift destinations" });
  await dock.getByRole("button", { name: /^Activity/ }).click();
  const details = page.getByRole("region", { name: "File preview" });
  const select = name => page.getByRole("button", { name: "View received " + name, exact: true }).click();
  const preview = details.getByRole("button", { name: "Preview verified text", exact: true });
  await select("Harbor survey.pdf");
  assert.equal(await preview.count(), 0, "PDF remains metadata and Files only");
  await select("Verified notes.txt");
  assert.deepEqual(await page.evaluate(() => window.previewCalls), [], "selection does not initiate native reads");
  await preview.click();
  await page.waitForFunction(() => typeof window.releasePreview === "function");
  await select("Other receipt.txt");
  await page.evaluate(() => window.releasePreview());
  assert.equal(await details.getByText("Discard the stale response").count(), 0);
  await preview.click();
  const output = details.locator("pre[aria-label='Verified plain text']");
  await output.waitFor();
  assert.equal(await output.textContent(), literal);
  assert.equal(await output.locator("strong,a,img,iframe").count(), 0, "literal markup is inert");
  assert.deepEqual(await page.evaluate(() => window.previewCalls), [
    ["preview_ios_received_text", { receiptId: "a".repeat(64) + ":c6991e6c-ecd2-4f10-905c-0f254040dda7" }],
    ["preview_ios_received_text", { receiptId: "a".repeat(64) + ":c6991e6c-ecd2-4f10-905c-0f254040dda8" }],
  ]);
  console.log("iOS received Activity fixture: selection-only native request, inert text, stale result discarded.");
} finally {
  await browser.close();
}
