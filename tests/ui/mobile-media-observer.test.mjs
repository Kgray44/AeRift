import test from "node:test";
import assert from "node:assert/strict";
import { observeMobileMedia } from "../../apps/aerift/src/ios/mobile-media-observer.ts";

test("an import completed after navigation updates the new subscriber and defeats stale reads", async () => {
  let finishList;
  let finishImport;
  const imported = [{ id: "asset", name: "Coastline.heic" }];
  const port = observeMobileMedia({
    list: () => new Promise(resolve => { finishList = resolve; }),
    import: () => new Promise(resolve => { finishImport = resolve; }),
  });

  const requested = port.list();
  const pending = port.import("photos");
  const first = [];
  const leave = port.subscribe(items => first.push(items));
  leave();
  const returned = [];
  port.subscribe(items => returned.push(items));

  finishImport({ ok: true, value: imported });
  assert.deepEqual(await pending, { ok: true, value: imported });
  finishList({ ok: true, value: [] });
  assert.deepEqual(await requested, { ok: true, value: imported });
  assert.deepEqual(first, []);
  assert.deepEqual(returned, [imported]);
  const later = [];
  port.subscribe(items => later.push(items));
  assert.deepEqual(later, [imported]);
});
