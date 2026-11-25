import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const module = process.env.AERIFT_PLAYWRIGHT_MODULE;
const { chromium } = await import(module ? pathToFileURL(module).href : "playwright");
const root = process.env.AERIFT_FIXTURE_URL ?? "http://127.0.0.1:4175";
const browser = await chromium.launch({
  executablePath: process.env.AERIFT_CHROMIUM,
  args: ["--disable-background-networking", "--no-proxy-server"],
});
const context = await browser.newContext({ serviceWorkers: "block" });
const outbound = [];
await context.route("**/*", async route => {
  if (new URL(route.request().url()).origin === new URL(root).origin) return route.continue();
  outbound.push(route.request().url());
  return route.abort();
});
const requests = async page => JSON.parse(await page.locator('pre[aria-label="Fixture requests"]').textContent() || "[]");
const button = (page, name) => page.getByRole("button", { name, exact: true });
const fixture = (page, mode = "") => page.goto(root + "/trusted-browser.html?mode=" + mode);
try {
  const page = await context.newPage({ viewport: { width: 1024, height: 800 } });
  page.setDefaultTimeout(5000);
  await fixture(page);
  await page.getByRole("combobox", { name: "Category" }).selectOption("research");
  assert.equal(await button(page, "Personal reference").count(), 0);
  await button(page, "Team handbook").click();
  assert.match(await page.getByRole("textbox", { name: "Web address" }).inputValue(), /handbook$/);
  assert.deepEqual(await requests(page), []);
  await button(page, "Recents").click();
  await button(page, "Recent fixture").waitFor();
  await button(page, "Saved").click();
  await page.getByRole("textbox", { name: "Web address" }).fill("workspace.fixture.invalid/new-source");
  await button(page, "Save page").click();
  await button(page, "/new-source").waitFor();
  await page.getByRole("combobox", { name: "Category" }).selectOption("personal");
  assert.equal(await button(page, "/new-source").count(), 0);
  await button(page, "Open in Workspace").click();
  await page.getByText("Native pane presented (640 × 480); page load not confirmed.", { exact: true }).waitFor();
  assert.equal(await button(page, "Back").isDisabled(), true);
  await page.getByRole("textbox", { name: "Web address" }).fill("workspace.fixture.invalid/second");
  await button(page, "Open in Workspace").click();
  await button(page, "Back").click();
  await button(page, "Forward").click();
  await button(page, "Reload").click();
  await button(page, "Close").click();
  assert.deepEqual((await requests(page)).map(r => r.kind), ["present", "navigate", "back", "forward", "reload", "close"]);
  await page.getByRole("textbox", { name: "Web address" }).fill("https://outside.fixture.invalid");
  await button(page, "Open in Workspace").click();
  await page.getByText(/address isn’t approved/).waitFor();
  await button(page, "Open in default browser").click();
  assert.equal((await requests(page)).at(-1).kind, "default-browser");
  assert.equal(context.pages().length, 1);
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 780 });
    const sizes = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.equal(sizes[0], sizes[1], "trusted chrome should not overflow horizontally");
  }
  for (const [mode, expected] of [
    ["queued", "Waiting for the native pane…"],
    ["malformed", "Pages open in your default browser."],
    ["unverified", "Pages open in your default browser."],
  ]) {
    await fixture(page, mode);
    const address = page.getByRole("textbox", { name: "Web address" });
    await address.fill("https://workspace.fixture.invalid");
    if (mode === "unverified") {
      assert.equal(await button(page, "Open in Workspace").count(), 0);
      assert.deepEqual(await requests(page), []);
    } else {
      await button(page, "Open in Workspace").click();
    }
    await page.getByText(expected, { exact: true }).waitFor();
    assert.equal(await page.getByText(/Native pane presented/).count(), 0);
    if (mode === "queued") assert.equal(await button(page, "Back").isDisabled(), true);
  }
  assert.deepEqual(outbound, []);
  console.log("Trusted browser fixture: verified layout, categories, save, address/navigation, request bounds, queued/unverified truth, and zero external page requests.");
} finally {
  await browser.close();
}
