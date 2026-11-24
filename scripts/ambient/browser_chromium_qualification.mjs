// Windows GitHub-hosted CI only. No user profile, real site, data, or durable install.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.ok(process.env.RUNNER_TEMP && process.env.AERIFT_FIXTURE_TOOLS && process.env.SystemRoot);
const requireFixture = createRequire(join(process.env.AERIFT_FIXTURE_TOOLS, "fixture.cjs"));
const { default: puppeteer } = await import(pathToFileURL(requireFixture.resolve("puppeteer")));
const root = await mkdtemp(join(process.env.RUNNER_TEMP, "aerift-browser-fixture-"));
const sandbox = join(root, "extension");
const manifestPath = join(root, "test-host.json");
const host = `com.aerift.fixture_${randomUUID().replaceAll("-", "")}`;
const nativeKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${host}`;
const reg = join(process.env.SystemRoot, "System32", "reg.exe");
const runReg = (...args) => spawnSync(reg, [...args, "/reg:64"], {
  encoding: "utf8", timeout: 4000, windowsHide: true,
});
const query = () => runReg("query", nativeKey, "/ve");
const ownsRegistration = (result) => result.status === 0 && result.stdout
  .split(/\r?\n/).some(line => line.includes("REG_SZ") && line.split("REG_SZ")[1].trim() === manifestPath);

const fixtureSelection = "AeRift exact synthetic selection.";
let browser;
let registered = false;
const listener = createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'",
    "Cache-Control": "no-store",
  });
  res.end(`<!doctype html><title>Synthetic AeRift fixture</title>
    <p id="selection">${fixtureSelection}</p><p>Unselected synthetic decoy.</p>
    <input id="protected" type="password" value="synthetic-only">`);
});
try {
  await mkdir(sandbox);
  const source = "apps/browser-extension";
  for (const name of ["manifest.json", "capture.mjs", "worker.mjs"]) {
    let value = await readFile(join(source, name), "utf8");
    if (name === "worker.mjs") {
      // Change only the registry name so this test cannot touch a real host.
      const original = 'const HOST = "com.aerift.ambient_browser";';
      assert.equal(value.split(original).length, 2);
      value = value.replace(original, `const HOST = "${host}";`);
      // Diagnostics in the fixture copy only: no inputs or content are logged.
      value = value.replace('let status = "Unavailable";', 'let status = "Unavailable"; let phase = "tab";')
        .replace('const focused =', 'phase = "focus"; const focused =')
        .replace('const [frame] =', 'phase = "snapshot"; const [frame] =')
        .replace('const snapshot =', 'phase = "plan"; const snapshot =')
        .replace('const [same] =', 'phase = "recheck"; const [same] =')
        .replace('const reply =', 'phase = "native"; const reply =')
        .replace('if (reply?.version', 'phase = "reply"; if (reply?.version')
        .replace('} catch {', '} catch (error) { globalThis.fixtureError = phase === "native" ? String(error.message) : error.name;')
        .replace('} finally {', '} finally { globalThis.fixturePhase = phase;');
    }
    await writeFile(join(sandbox, name), value);
  }
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  browser = await puppeteer.launch({
    headless: false,
    pipe: true,
    userDataDir: join(root, "profile"),
    enableExtensions: true,
    args: ["--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-sync"],
  });
  const id = await browser.installExtension(sandbox);
  assert.match(id, /^[a-p]{32}$/);
  const extension = (await browser.extensions()).get(id);
  assert.ok(extension?.enabled);

  const build = spawnSync("cargo", ["build", "--locked", "-p", "aerift-transfer",
    "--example", "ambient_browser_exact_fixture"], {
    timeout: 8 * 60 * 1000,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: join(root, "cargo"),
      AERIFT_BROWSER_ALLOWED_ORIGIN: `chrome-extension://${id}/` },
    windowsHide: true,
  });
  assert.equal(build.status, 0, "could not build CI-only fixture host");
  const executable = await realpath(join(root, "cargo", "debug", "examples", "ambient_browser_exact_fixture.exe"));
  const manifest = origin => writeFile(manifestPath, JSON.stringify({
    name: host, description: "Synthetic AeRift Chromium test host",
    path: executable, type: "stdio", allowed_origins: [`chrome-extension://${origin}/`],
  }));
  const stale = `${id[0] === "a" ? "b" : "a"}${id.slice(1)}`;
  await manifest(stale);
  assert.equal(query().status, 1, "will not overwrite any existing registry key");
  assert.equal(runReg("add", nativeKey, "/ve", "/t", "REG_SZ", "/d", manifestPath).status, 0);
  registered = true;
  assert.ok(ownsRegistration(query()));

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${listener.address().port}/`);
  await page.bringToFront();
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#selection"));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
  const workerEntry = await browser.waitForTarget(
    t => t.type() === "service_worker" && t.url() === `chrome-extension://${id}/worker.mjs`,
    { timeout: 10000 },
  );
  const worker = await workerEntry.worker();
  assert.ok(worker);
  const getTitle = () => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return await chrome.action.getTitle({ tabId: tab.id });
  });
  const expectTitle = async (expected) => {
    for (let n = 0; n < 100; n++) {
      if (await getTitle() === expected) return;
      await delay(50);
    }
    const diagnostic = await worker.evaluate(() => ({
      phase: globalThis.fixturePhase, error: globalThis.fixtureError,
    }));
    throw new Error(`Browser action did not reach ${expected}; ${JSON.stringify(diagnostic)}`);
  };
  assert.equal(await getTitle(), "Prepare AeRift pickup (does not send)");
  await page.triggerExtensionAction(extension);
  await expectTitle("AeRift: Unavailable");
  console.log("Disposable Chromium denies the fixture when the resolved host manifest lists a different extension ID.");

  await manifest(id);
  await page.triggerExtensionAction(extension);
  await expectTitle("AeRift: Snapshot validated; nothing sent");
  console.log("Actual extension action and Chromium native messaging delivered the exact synthetic selection once.");

  await page.focus("#protected");
  await page.triggerExtensionAction(extension);
  await expectTitle("AeRift: Unavailable");
  await browser.uninstallExtension(id);
  console.log("Protected synthetic context refused; no app intake, real data, or transfer.");
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      if (registered) {
        assert.ok(ownsRegistration(query()), "will not delete changed registry value");
        assert.equal(runReg("delete", nativeKey, "/f").status, 0);
        assert.equal(query().status, 1, "fixture registration was not removed");
      }
    } finally {
      listener.close();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }
}
