import { test } from "node:test";
import assert from "node:assert/strict";
import { mobileReceivedRows } from "../../apps/aerift/src/ios/mobile-received-activity.ts";

const key = "received-" + "a".repeat(64);
const activity = [
  {id:"x", file:{name:"Survey.pdf",sizeBytes:123},state:"completed",direction:"incoming"},
  {id:"y", file:{name:"Incomplete.txt",sizeBytes:12},state:"pending",direction:"incoming"},
  {id:"z", file:{name:"Sent.txt",sizeBytes:1},state:"completed",direction:"outgoing"},
];
test("offers and outgoing files never appear in Received", () => {
  assert.deepEqual(mobileReceivedRows(activity).map(row => row.name), ["Survey.pdf"]);
});
test("native catalog is authoritative when ready; no fabricated duplicates", () => {
  assert.deepEqual(mobileReceivedRows(activity, [
    {id:key,name:"Survey.pdf",sizeBytes:123},
    {id:"outside",name:"not-native",sizeBytes:1},
    {id:key,name:"duplicate",sizeBytes:2},
  ]), [{id:key,name:"Survey.pdf",sizeBytes:123}]);
  assert.deepEqual(mobileReceivedRows(activity, []), []);
});
