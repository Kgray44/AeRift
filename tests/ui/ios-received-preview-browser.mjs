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
  const reopened = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const saved = { id: "a".repeat(64) + ":f6ee6d8d-8d96-4972-8e0a-0eb538067fa6", name: "Saved verified.txt", sizeBytes: 14 };
  await reopened.addInitScript(row => {
    let authorized = false;
    window.savedReceiptCalls = [];
    window.__TAURI_INTERNALS__ = { invoke: async (name, args) => {
      window.savedReceiptCalls.push([name, args]);
      if (name === "configure_ios_receipt_history") {
        authorized = args.enabled;
        if (!authorized || args.clear) localStorage.removeItem("fixture-native-receipt");
        else if (!localStorage.getItem("fixture-receipt-seeded")) {
          localStorage.setItem("fixture-native-receipt", JSON.stringify(row));
          localStorage.setItem("fixture-receipt-seeded", "yes");
        }
        return null;
      }
      if (name === "list_ios_received_receipts" && authorized) {
        const text = localStorage.getItem("fixture-native-receipt");
        return text ? [JSON.parse(text)] : [];
      }
      if (name === "preview_ios_received_text" && authorized && args.receiptId === row.id &&
        localStorage.getItem("fixture-native-receipt")) return "Protected text";
      return Promise.reject({ code: "invalid_request" });
    } };
  }, saved);
  const openActivity = () => reopened.getByRole("navigation", { name: "AeRift destinations" })
    .getByRole("button", { name: /^Activity/ }).click();
  const openSettings = async () => {
    await reopened.getByRole("button", { name: "Control Center", exact: true }).click();
    return reopened.getByRole("dialog", { name: "Control Center" });
  };
  const restored = reopened.getByRole("button", { name: "View received Saved verified.txt", exact: true });
  await reopened.goto(origin + "/mobile.html");
  await openActivity();
  assert.equal(await restored.count(), 0, "no protected history is read by default");
  assert.deepEqual(await reopened.evaluate(() => window.savedReceiptCalls), []);
  let settings = await openSettings();
  await settings.getByLabel("Keep final transfer outcomes after restart").check();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await restored.waitFor();
  await reopened.reload();
  await openActivity();
  await restored.click();
  const reopenedDetails = reopened.getByRole("region", { name: "File preview" });
  await reopenedDetails.getByRole("button", { name: "Preview verified text" }).click();
  await reopenedDetails.getByText("Protected text", { exact: true }).waitFor();
  settings = await openSettings();
  await settings.getByRole("button", { name: "Clear saved Activity", exact: true }).click();
  await settings.getByRole("button", { name: "Clear saved outcomes", exact: true }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await restored.waitFor({ state: "detached" });
  await reopened.reload();
  await openActivity();
  await reopened.waitForFunction(() => window.savedReceiptCalls.some(([name]) => name === "list_ios_received_receipts"));
  assert.equal(await restored.count(), 0, "cleared receipt does not reappear after restart");
  await reopened.close();
  console.log("iOS received Activity fixture: selection-only native request, inert text, stale result discarded.");
} finally {
  await browser.close();
}
