import assert from "node:assert/strict";
import { test } from "node:test";
import { getNavigation, restorePreferences } from "../../dist/packages/app-contract/src/experience.js";
import { friendTargets, ordinaryDevices } from "../../dist/packages/app-contract/src/friends.js";

const capabilities = { ambient: "unsupported", camera: "unknown" };
test("only a supported native capability advertises the Friends destination on either form factor", () => {
  for (const platform of ["desktop", "mobile"]) {
    const destinations = status => getNavigation(platform, restorePreferences(undefined), { ...capabilities, friends: status }).primary.map(x => x.id);
    assert.ok(!destinations(undefined).includes("friends"));
    assert.ok(!destinations("unsupported").includes("friends"));
    assert.ok(destinations("available").includes("friends"));
  }
});
test("authorized friend devices leave the regular list; the chosen friend cannot target another person's devices", () => {
  const snapshot = { version: 1, contacts: [{ id: "a", devices: [{ id: "p", availability: "offline" }] }, { id: "b", devices: [{ id: "q", availability: "online" }] }] };
  assert.deepEqual(ordinaryDevices([{id:"local"}, {id:"p"}, {id:"q"}], snapshot), [{id:"local"}]);
  assert.deepEqual(friendTargets(snapshot, "a"), [{ id: "p", availability: "offline" }]);
  assert.deepEqual(friendTargets(snapshot, "unknown"), []);
  assert.deepEqual(ordinaryDevices([{id:"p"}], undefined), [{id:"p"}]);
});
test("personal devices are classified only by independently authorized native IDs, never by nearby pairing", async () => {
  const { partitionDevices } = await import("../../dist/packages/app-contract/src/friends.js");
  const nearby = { id: "local", paired: true };
  const mine = { id: "mine", paired: false };
  const friend = { id: "remote", paired: true };
  const friends = { version: 1, contacts: [{ id: "p", devices: [{ id: friend.id }] }] };
  assert.deepEqual(partitionDevices([nearby, mine, friend], friends, ["mine", "remote"]), { personal: [mine], nearby: [nearby] });
  assert.deepEqual(partitionDevices([nearby], undefined), { personal: [], nearby: [nearby] });
});
