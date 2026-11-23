import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [driver, executablePath, profile, stagedRoot, scenario] = process.argv.slice(2);
if (!driver || !executablePath || !profile || !stagedRoot) {
  throw new Error("Usage: node tests/gestures/replay.mjs <playwright-core/index.mjs> <Chromium executable> <profile> <staged replay root> [offer]");
}
const { chromium } = await import(pathToFileURL(resolve(driver)).href);
const types = { js: "text/javascript", cjs: "text/javascript", wasm: "application/wasm", jpg: "image/jpeg", html: "text/html" };
const root = resolve(stagedRoot);
const photos = scenario === "offer" ? {
  "right_hands.jpg": "4b5134daa4cb60465535239535f9f74c2842aba3aa5fd30bf04ef5678f93d87f",
  "fist.jpg": "43fa1cabf3f90d574accc9a56986e2ee48638ce59fc65af1846487f73bb2ef24",
} : { "pointing_up.jpg": "ecf8ca2611d08fa25948a4fc10710af9120e88243a54da6356bacea17ff3e36e" };
for (const [name, digest] of Object.entries(photos)) {
  const photo = await readFile(resolve(root, name));
  if (createHash("sha256").update(photo).digest("hex") !== digest) throw new Error("Unexpected SHA-256 for " + name);
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  let file;
  if (path === "/favicon.ico") return res.writeHead(204).end();
  if (path === "/") file = resolve(scenario === "offer" ? "tests/gestures/offer-replay.html" : "tests/gestures/replay.html");
  else if (/^\/dist\/gestures\/packages\/gestures\/src\/[a-z-]+\.js$/.test(path)) file = resolve("." + path);
  else if (Object.hasOwn(photos, path.slice(1)) || /^\/gesture-assets\/(wasm\/)?[a-z_.-]+$/.test(path)) file = resolve(root, "." + path);
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
  await page.waitForFunction(() => Boolean(window.replayResult), undefined, { timeout: scenario === "offer" ? 90_000 : 30_000 });
  const result = await page.evaluate(() => window.replayResult);
  console.log(JSON.stringify({ browser: browser.browser()?.version() ?? executablePath.split(/[\\/]/).at(-1), ...result }, null, 2));
  if (!result.pass) process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
}
