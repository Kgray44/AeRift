import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [driver, executablePath, profile, stagedRoot] = process.argv.slice(2);
if (!driver || !executablePath || !profile || !stagedRoot) {
  throw new Error("Usage: node tests/gestures/replay.mjs <playwright-core/index.mjs> <Chromium executable> <profile> <staged replay root>");
}
const { chromium } = await import(pathToFileURL(resolve(driver)).href);
const types = { js: "text/javascript", cjs: "text/javascript", wasm: "application/wasm", jpg: "image/jpeg", html: "text/html" };
const root = resolve(stagedRoot);
const photo = await readFile(resolve(root, "pointing_up.jpg"));
if (createHash("sha256").update(photo).digest("hex") !== "ecf8ca2611d08fa25948a4fc10710af9120e88243a54da6356bacea17ff3e36e") {
  throw new Error("Unexpected replay photograph SHA-256");
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  let file;
  if (path === "/favicon.ico") return res.writeHead(204).end();
  if (path === "/") file = resolve("tests/gestures/replay.html");
  else if (/^\/dist\/gestures\/packages\/gestures\/src\/[a-z-]+\.js$/.test(path)) file = resolve("." + path);
  else if (/^\/(pointing_up\.jpg|gesture-assets\/(wasm\/)?[a-z_.-]+)$/.test(path)) file = resolve(root, "." + path);
  if (!file) return res.writeHead(404).end();
  try {
    const bytes = await readFile(file);
    res.writeHead(200, { "Content-Type": types[file.split(".").at(-1)] ?? "application/octet-stream" }).end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
let browser;
try {
  browser = await chromium.launchPersistentContext(resolve(profile), {
    executablePath, headless: true,
    args: ["--disable-background-networking", "--disable-breakpad", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const [page] = browser.pages();
  page.on("response", (response) => { if (!response.ok()) console.error(response.status(), new URL(response.url()).pathname); });
  page.on("pageerror", (error) => console.error(error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => Boolean(window.replayResult), undefined, { timeout: 30_000 });
  const result = await page.evaluate(() => window.replayResult);
  console.log(JSON.stringify({ browser: browser.browser()?.version() ?? executablePath.split(/[\\/]/).at(-1), ...result }, null, 2));
  if (!result.pass) process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
}
