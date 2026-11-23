import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [driver, output, port] = process.argv.slice(2);
const { webkit } = await import(pathToFileURL(driver).href);
const source = await readFile("tests/ui/mobile-browser-check.js", "utf8");
const { default: run } = await import("data:text/javascript;base64," + Buffer.from("export default " + source).toString("base64"));
const browser = await webkit.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto("http://127.0.0.1:" + port + "/mobile.html", { waitUntil: "networkidle" });
  const result = await run(page);
  console.log(result);
  await writeFile(join(output, "mobile-renderer.txt"), result + "\n");
} finally {
  await browser.close();
}
