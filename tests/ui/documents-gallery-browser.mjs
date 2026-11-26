import assert from "node:assert/strict";

// Call with the desktop document gallery open. This fixture exercises the
// existing OS-import bridge replacement provided by Playwright file injection.
export async function verifyDocumentsGallery(page) {
  const gallery = page.getByRole("region", { name: "Document gallery", exact: true });
  const categories = page.getByRole("complementary", { name: "Document categories", exact: true });
  const contents = "<script>window.documentPreviewScriptExecuted=true</script>\nNotebook text";
  await gallery.locator('input[type="file"]').setInputFiles([
    { name: "Notebook.txt", mimeType: "text/plain", buffer: Buffer.from(contents) },
    { name: "Syllabus.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") },
  ]);
  const notebook = gallery.getByRole("button", { name: "View Notebook.txt", exact: true });
  await notebook.waitFor();
  const search = gallery.getByRole("searchbox", { name: "Search imported documents", exact: true });
  await search.fill("notebook");
  assert.equal(await gallery.getByRole("button", { name: "View Syllabus.pdf", exact: true }).count(), 0);
  await notebook.press("Enter");
  const viewer = page.getByRole("dialog", { name: "Viewing Notebook.txt", exact: true });
  assert.equal(await viewer.getByRole("button", { name: "Open document preview", exact: true }).count(), 0);
  await viewer.getByRole("button", { name: "Preview document text", exact: true }).click();
  assert.equal(await viewer.locator('pre[aria-label="Document text"]').textContent(), contents);
  assert.equal(await viewer.locator("iframe,script,embed,object").count(), 0);
  assert.equal(await page.evaluate(() => !!window.documentPreviewScriptExecuted), false);
  await viewer.getByRole("button", { name: "Close document", exact: true }).press("Enter");
  await viewer.waitFor({ state: "hidden" });
  assert.equal(await notebook.evaluate(node => document.activeElement === node), true);

  await categories.getByRole("button", { name: "New document category", exact: true }).click();
  await categories.getByRole("textbox", { name: "Category name", exact: true }).fill("Study");
  await categories.getByRole("button", { name: "Save document category", exact: true }).click();
  await categories.getByRole("button", { name: "Recents", exact: true }).click();
  await notebook.click();
  await viewer.getByRole("button", { name: "Add to document category", exact: true }).click();
  await viewer.getByRole("button", { name: "Study", exact: true }).click();
  await viewer.getByRole("button", { name: "Close document", exact: true }).click();
  await categories.getByRole("button", { name: "Study", exact: true }).click();
  assert.equal(await notebook.count(), 1);
  assert.equal(await gallery.getByRole("button", { name: "View Syllabus.pdf", exact: true }).count(), 0);
}
