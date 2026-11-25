import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createMobileThumbnailReader, thumbnailJpeg } from "../../apps/aerift/src/ios/mobile-photo-thumbnail.ts";

const id = "ff1a587e-224a-41f0-a368-5ab457e719a3";
const second = "ff1a587e-224a-41f0-a368-5ab457e719a4";
const encoded = btoa(String.fromCharCode(255, 216, 255, 0, 1, 255, 217));
test("only bounded canonical JPEG transport becomes a fixed-type, same-app blob", async () => {
  const image = thumbnailJpeg(encoded);
  assert.equal(image?.type, "image/jpeg");
  assert.equal(image?.size, 7);
  for (const invalid of ["", "data:image/jpeg;base64," + encoded, encoded + "\n", btoa("<svg/>"),
     btoa(String.fromCharCode(255, 216, 255, 0, 1, 0, 0)), "A".repeat(174768)]) {
    assert.equal(thumbnailJpeg(invalid), undefined);
  }
});
test("thumbnail requests serialize and an unmounted cell cannot publish or wake its queued request", async () => {
  const seen = [];
  let complete;
  const read = createMobileThumbnailReader(async key => {
    seen.push(key);
    return new Promise(resolve => { complete = resolve; });
  });
  const firstGone = new AbortController(), secondGone = new AbortController();
  const first = read(id, firstGone.signal);
  const queued = read(second, secondGone.signal);
  await Promise.resolve();
  assert.deepEqual(seen, [id]);
  firstGone.abort();
  secondGone.abort();
  complete({ ok: true, value: encoded });
  assert.equal(await first, undefined);
  assert.equal(await queued, undefined);
  assert.equal(await read("/some/other/location"), undefined);
  assert.deepEqual(seen, [id]);
});
test("thumbnail commands are mobile-only, opaque, capped and do not call a file picker", () => {
  const file = path => readFileSync(new URL("../../apps/aerift/src-tauri/src/" + path, import.meta.url), "utf8");
  for (const platform of ["ios", "android"]) {
    assert.match(file(platform + ".rs"), new RegExp(`async fn thumbnail_${platform}_media[\\s\\S]*?asset_id: Uuid[\\s\\S]*?require_thumbnail_origin\\(&window\\)\\?`));
    assert.match(file("lib.rs"), new RegExp(`${platform}::thumbnail_${platform}_media`));
  }
  const guard = file("mobile_photo_thumbnail.rs");
  assert.match(guard, /128 \* 1024/);
  assert.match(guard, /compare_exchange/);
  assert.match(guard, /tauri\.localhost/);
});
test("Android thumbnail bridge is exported to the platform command", () => {
  const source = readFileSync(new URL("../../apps/aerift/src-tauri/src/platform/android/src/lib.rs", import.meta.url), "utf8");
  assert.match(source, /pub use storage::\{[^}]*\bthumbnail_media\b/);
});
