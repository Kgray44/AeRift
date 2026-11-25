import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const desktop = "apps/aerift/src/windows/";

test("Control Center shows one selected, keyboard-accessible settings group", () => {
  const source = read(desktop + "DesktopSettings.tsx");
  assert.match(source, /aria-label="Settings categories"/);
  assert.match(source, /aria-pressed=\{category === id\}/);
  for (const [id, category] of Object.entries({ experience: "general", appearance: "appearance", gestures: "camera",
    "transfer-settings": "transfers", clipboard: "privacy", ambient: "ambient" })) {
    assert.ok(source.includes(`<section hidden={category !== "${category}"} aria-labelledby="${id}-heading">`),
      `Hide the inactive ${id} group from visual and keyboard navigation`);
  }
});

test("standard Remote calls folders by their product name and preserves the review and save steps", () => {
  const source = read(desktop + "PrivateRemoteFolders.tsx");
  assert.doesNotMatch(source, /qualification|synthetic test folders/i);
  assert.match(source, /Accept folder and choose destination/);
  assert.match(source, /Save verified folder without replacing files/);
});

test("private-network configuration explains the current scope without advertising development features", () => {
  const source = read(desktop + "RemoteModeSettings.tsx");
  assert.match(source, /<details[^>]*>\s*<summary>Remote transfers over a private VPN<\/summary>/);
  assert.match(source, /confirmed: next === null \|\| authorized/);
  assert.match(source, /mode\?\.restartNeeded/);
});
