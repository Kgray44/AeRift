import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");

test("the Friends sender targets only a person and does not render their devices or routes", () => {
  const workspace = read("apps/aerift/src/FriendsWorkspace.tsx");
  const windows = read("apps/aerift/src/windows/WindowsFriendsFiles.tsx");
  assert.doesNotMatch(workspace, /devices\.map|revoke_device|Send to<select/);
  assert.match(workspace, /target: \{ friendId: contact\.id \}/);
  assert.doesNotMatch(windows, /offer_person|payloadRoute|offerRoute|recipient\.id|outgoing\[2\]/);
  assert.match(windows, /action: "offer_contact", friendId: person/);
});

test("Friends requires a verified route and allows explicit accept and decline on this device", () => {
  const windows = read("apps/aerift/src/windows/WindowsFriendsFiles.tsx");
  assert.match(windows, /!view\.personTransfersAvailable/);
  assert.match(windows, /action: "accept_contact_offer", id: offer\.id/);
  assert.match(windows, /action: "decline_contact_offer", id: offer\.id/);
  assert.match(windows, /!view\.canRelease/);
});
