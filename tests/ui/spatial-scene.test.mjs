import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { reconcilePeerSlots } from "../../packages/ui/src/spatial-placement.ts";
import { devicePresence } from "../../packages/ui/src/spatial-device.ts";

test("device signals reserve readiness for available paired devices", () => {
  assert.deepEqual(devicePresence({ online: true, paired: true }, { ready: true }), ["ready", "Ready to receive"]);
  assert.deepEqual(devicePresence({ online: false, paired: true }, { ready: true }), ["offline", "Offline"]);
  assert.deepEqual(devicePresence({ online: true, paired: false }, { ready: true }), ["unpaired", "Unpaired"]);
  assert.deepEqual(devicePresence({ online: true, paired: true }, { selected: true }), ["selected", "Selected"]);
  assert.deepEqual(devicePresence({ online: true, paired: true }, { offered: true }), ["offered", "Offer pending"]);
  assert.deepEqual(devicePresence({ online: true, paired: true }, { active: true, interrupted: true }),
    ["interrupted", "Transfer interrupted"]);
});

test("discovery keeps existing peer positions across updates", () => {
  const first = reconcilePeerSlots(new Map(), ["phone", "laptop", "desktop"]);
  assert.deepEqual([...first], [["phone", 0], ["laptop", 1], ["desktop", 2]]);
  assert.equal(reconcilePeerSlots(first, ["desktop", "phone", "laptop"]), first);
  const next = reconcilePeerSlots(first, ["tablet", "desktop", "phone"]);
  assert.deepEqual([...next], [["phone", 0], ["desktop", 2], ["tablet", 1]]);
});

test("extra peers retain individual positions in the compact list", () => {
  const ids = Array.from({ length: 10 }, (_, index) => `peer-${index}`);
  const crowded = reconcilePeerSlots(new Map(), ids);
  assert.equal(new Set(crowded.values()).size, ids.length);
  const next = reconcilePeerSlots(crowded, ["peer-8", "peer-1", "arrival"]);
  assert.equal(next.get("peer-8"), 8);
  assert.equal(next.get("peer-1"), 1);
  assert.equal(next.get("arrival"), 0);
});

test("compact native headers retain Settings only through existing navigation", async () => {
  const [desktop, phone, dock, header] = await Promise.all([
    "windows/DesktopApp.tsx", "ios/IosApp.tsx", "ios/MobileNavigation.tsx", "CompactHeader.tsx",
  ].map(file => readFile(new URL(`../../apps/aerift/src/${file}`, import.meta.url), "utf8")));
  for (const source of [desktop, phone]) {
    assert.match(source, /<CompactHeaderMark\s*\/>/);
    assert.match(source, /<CompactHeaderStatus/);
    assert.doesNotMatch(source, /aria-label="Control Center"/);
  }
  assert.match(desktop, /<Orbit destinations=\{navigation\.primary\}/);
  assert.match(phone, /<Sheet[^>]+title="Control Center"/);
  assert.match(dock, /aria-haspopup="dialog"/);
  assert.match(header, /aerift-mark-transparent.png/);
  assert.doesNotMatch(header, /<button/);
});
