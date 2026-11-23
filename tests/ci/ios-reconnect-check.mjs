import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [driver, edge, dist, output] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(driver).href);
await mkdir(output, { recursive: true });
const contentTypes = { html: "text/html", js: "text/javascript", css: "text/css", png: "image/png" };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const file = path === "/" ? "index.html" : path.slice(1);
  if (!/^(index\.html|assets\/[a-z0-9_.-]+)$/i.test(file)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(resolve(dist, file));
    response.writeHead(200, { "Content-Type": contentTypes[file.split(".").at(-1)] }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(ready => server.listen(0, "127.0.0.1", ready));
let browser;
try {
  browser = await chromium.launch({ executablePath: edge, headless: true, args: ["--disable-background-networking"] });
  const receipts = [];
  for (const discovery of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.addInitScript(injectApp, discovery);
    await page.goto("http://127.0.0.1:" + server.address().port);
    const toolbar = page.locator("header");
    await toolbar.getByText("Disconnected", { exact: true }).waitFor();
    if (!discovery) await page.evaluate(() => window.fixture.recover());
    const retryLabel = discovery ? "Retry discovery" : "Retry connection";
    await page.getByRole("button", { name: retryLabel, exact: true }).click();
    await toolbar.getByText("Paired", { exact: true }).waitFor();
    await page.getByText("Qualification Windows", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Devices", exact: true }).click();
    const devices = page.getByRole("dialog");
    await devices.getByText("Qualification Windows", { exact: true }).waitFor();
    await devices.getByText("Online", { exact: true }).waitFor();
    const watchCalls = await page.evaluate(() => window.fixture.watchCalls());
    assert.equal(watchCalls, discovery ? 1 : 2, retryLabel);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: resolve(output, discovery ? "discovery.png" : "connection.png") });
    receipts.push({ retryLabel, watchCalls, toolbar: "Paired", devices: "Online" });
    await context.close();
  }
  console.log(JSON.stringify(receipts));
  await writeFile(resolve(output, "receipt.json"), JSON.stringify(receipts, null, 2) + "\n");
} finally {
  await browser?.close();
  server.close();
}

function injectApp(discovery) {
  const callbacks = new Map();
  const watches = new Map();
  let sequence = 0;
  let available = discovery;
  let watchCalls = 0;
  const peer = { id: "peer-1", name: "Qualification Windows", platform: "windows", paired: true, online: true };
  const snapshot = {
    version: 1,
    devices: discovery ? [] : [peer],
    transfers: [],
    pendingPairing: [],
    localNetwork: discovery ? "unavailable" : "ready",
  };
  const emit = (id, index) => callbacks.get(id)?.({ index, message: structuredClone(snapshot) });
  Object.defineProperty(globalThis, "isTauri", { value: true });
  globalThis.__TAURI_INTERNALS__ = {
    transformCallback(callback) { callbacks.set(++sequence, callback); return sequence; },
    unregisterCallback(id) { callbacks.delete(id); },
    invoke(command, args) {
      if (command === "watch_app") {
        watchCalls++;
        if (!available) return Promise.reject({ code: "network_error" });
        const id = args.updates.id;
        watches.set(id, 1);
        emit(id, 0);
        return Promise.resolve(id);
      }
      if (command === "unwatch_app") {
        watches.delete(args.subscriptionId);
        return Promise.resolve();
      }
      if (command === "retry_ios_discovery") {
        snapshot.devices = [peer];
        snapshot.localNetwork = "ready";
        for (const [id, index] of watches) {
          emit(id, index);
          watches.set(id, index + 1);
        }
        return Promise.resolve();
      }
      return Promise.reject({ code: "invalid_request" });
    },
  };
  globalThis.fixture = { recover() { available = true; }, watchCalls: () => watchCalls };
}
