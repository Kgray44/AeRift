import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

// One opaque 1×1 local pixel with valid PNG chunks; never an external image.
function pixel() {
  function chunk(type, payload) {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length);
    const data = Buffer.concat([Buffer.from(type), payload]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, tail]);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk("IDAT", deflateSync(Buffer.from([0, 72, 144, 227]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function verifyFriendProfiles(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1060, height: 850 } });
  try {
    await page.goto(base + "/desktop-visual.html?route=friends&friendsFixture=1");
    const editOwn = page.getByRole("button", { name: "Edit my profile" });
    await editOwn.click();
    const own = page.getByRole("dialog", { name: "My profile" });
    await own.getByLabel("Display name").fill("Field researcher");
    await own.getByLabel("Nickname (optional)").fill("Scout");
    await own.getByRole("tab", { name: "Glass styles" }).click();
    assert.equal(await own.locator(".ae-profile-choice").count(), 6);
    await own.getByRole("button", { name: "Sea glass" }).click();
    await own.getByRole("button", { name: "Save profile" }).click();
    await own.waitFor({ state: "hidden" });
    await page.locator(".ae-friends-own strong").getByText("Scout", { exact: true }).waitFor();

    await page.getByRole("button", { name: "Test contact A" }).click();
    await page.getByRole("button", { name: "Edit friend appearance" }).click();
    const friend = page.getByRole("dialog", { name: "Edit friend appearance" });
    assert.equal(await friend.getByText("Test contact A", { exact: true }).count(), 2);
    await friend.getByLabel("Name on this device").fill("Field teammate");
    await friend.getByLabel("Nickname (optional)").fill("Fox");
    await friend.getByRole("tab", { name: "Recently received" }).click();
    await friend.getByText(/Save one from Inbox/).waitFor();
    await friend.getByRole("tab", { name: "Upload image" }).click();
    const file = friend.getByLabel("Choose profile image file");
    await file.setInputFiles({ name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("not a raster") });
    await friend.getByRole("alert").waitFor();
    await file.setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: pixel() });
    await friend.locator(".ae-profile-summary img").waitFor();
    const preview = friend.locator(".ae-profile-summary img");
    assert.match(await preview.getAttribute("src"), /^blob:/);
    await preview.evaluate(img => img.decode());
    assert.equal(await preview.evaluate(img => img.naturalWidth), 192);
    await friend.getByRole("button", { name: "Save appearance" }).click();
    await friend.waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "Fox" }).waitFor();
    await page.getByText("Verified as Test contact A").waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Fox" }).click();
    await page.getByRole("heading", { name: "Fox" }).waitFor();
    const savedPhoto = page.locator(".ae-friends-contact-heading img");
    await savedPhoto.waitFor();
    assert.match(await savedPhoto.getAttribute("src"), /^blob:/);
    await page.getByRole("button", { name: "Edit friend appearance" }).click();
    await friend.getByRole("button", { name: "Reset to default" }).click();
    await friend.getByRole("button", { name: "Save appearance" }).click();
    await page.getByRole("heading", { name: "Test contact A" }).waitFor();
  } finally { await page.close(); }
}
