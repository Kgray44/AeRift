import assert from "node:assert/strict";

// Call with a browser page at desktop-visual.html?route=activity&inboxFixture=1.
// The optional time expects a fixture with actual native receipt metadata.
export async function verifyReceivedActivity(page, { expectedTime } = {}) {
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const item = inbox.getByRole("button", { name: "View received Verified survey.pdf", exact: true });
  await item.waitFor();
  await item.press("Enter");
  const detail = inbox.getByRole("region", { name: "File preview", exact: true });
  await detail.getByText("Verified survey.pdf", { exact: true }).waitFor();
  assert.equal(await detail.evaluate(node => node === document.activeElement), true);
  await detail.getByText("Document", { exact: true }).waitFor();

  if (expectedTime) {
    assert.equal(await detail.locator("time").getAttribute("datetime"), expectedTime);
    const timeline = inbox.getByRole("region", { name: "Receipt timeline" });
    await timeline.getByRole("button", { name: "View timeline entry for Verified survey.pdf", exact: true }).waitFor();
  } else {
    await detail.getByText("Receipt time unavailable", { exact: true }).waitFor();
  }
  await detail.getByRole("button", { name: "Close details", exact: true }).press("Enter");
  assert.equal(await item.evaluate(node => node === document.activeElement), true);
}
