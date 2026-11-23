import assert from "node:assert/strict";
import test from "node:test";
import { mobileDestinations, summarizeMobile } from "../../apps/aerift/src/ios/mobile-experience.ts";

test("mobile destinations put Rift between Workspace and Devices", () => {
  assert.deepEqual(mobileDestinations, ["home", "workspace", "rift", "devices", "activity"]);
});

test("offers, active transfers and delivered objects are reported separately", () => {
  const transfers = [
    { id: "first", direction: "incoming", state: "completed" },
    { id: "offer", direction: "incoming", state: "pending" },
    { id: "active", direction: "outgoing", state: "transferring" },
    { id: "failure", direction: "incoming", state: "failed" },
    { id: "outgoing", direction: "outgoing", state: "completed" },
  ];
  const result = summarizeMobile({ transfers, devices: [
    { id: "trusted", online: true, paired: true },
    { id: "available", online: true, paired: false },
    { id: "offline", online: false, paired: true },
  ], pendingPairing: [{ requestId: "pair" }] });
  assert.equal(result.trustedOnline, 1);
  assert.equal(result.available, 2);
  assert.equal(result.pairRequests, 1);
  assert.equal(result.incomingOffers, 1);
  assert.deepEqual(result.active.map(item => item.id), ["offer", "active"]);
  assert.deepEqual(result.received.map(item => item.id), ["first"]);
  assert.deepEqual(summarizeMobile(undefined).active, []);
});
