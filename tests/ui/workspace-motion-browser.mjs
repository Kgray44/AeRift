import assert from "node:assert/strict";
import { join } from "node:path";

export async function verifyWorkspaceReactMotion(browser, root, evidence) {
  const folder = evidence ? join(evidence, "workspace-motion-video") : undefined;
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 },
    reducedMotion: "no-preference", ...(folder ? { recordVideo: { dir: folder, size: { width: 960, height: 672 } } } : {}) });
  try {
    await page.goto(root + "/desktop-visual.html?route=workspace&state=empty");
    const card = page.getByRole("button", { name: "Notes", exact: true });
    await card.waitFor();
    const before = await card.boundingBox();
    await card.hover();
    await page.waitForFunction(() => [...document.querySelectorAll(".aw-card-button:hover .aw-symbol")]
      .some(node => getComputedStyle(node).transform !== "none"), null, { timeout: 3500 });
    assert.deepEqual(await card.boundingBox(), before, "the hit target doesn't drift when its glass symbol lifts");
    await card.click();
    const heading = page.getByRole("heading", { name: "Notes", exact: true, level: 3 });
    await heading.waitFor();
    assert.equal(await heading.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.getByRole("button", { name: "Notes", exact: true }).count(), 0, "only one route remains interactive");
    if (evidence) await page.screenshot({ path: join(evidence, "workspace-motion-revealed.png") });
    await page.getByRole("button", { name: "Back to Workspace", exact: true }).click();
    assert.equal(await card.evaluate(node => node === document.activeElement), true);
  } finally {
    await page.close();
  }

  for (const reduce of ["app", "system"]) {
    const compact = await browser.newPage({ viewport: { width: 360, height: 800 },
      reducedMotion: reduce === "system" ? "reduce" : "no-preference" });
    try {
      await compact.goto(root + "/desktop-visual.html?route=workspace&state=empty&" + (reduce === "app" ? "motion=reduce" : ""));
      const card = compact.getByRole("button", { name: "Notes", exact: true });
      await card.hover();
      await compact.waitForTimeout(250);
      const transform = await card.locator(".aw-symbol").evaluate(node => getComputedStyle(node).transform);
      assert.ok(transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)", reduce + " leaves the symbol static");
      await card.press("Enter");
      const heading = compact.getByRole("heading", { name: "Notes", exact: true, level: 3 });
      assert.equal(await heading.evaluate(node => node === document.activeElement), true);
    } finally {
      await compact.close();
    }
  }
}
