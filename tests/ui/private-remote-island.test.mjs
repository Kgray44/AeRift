import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const file = { peerId: "peer", id: "offer", name: "Tidal charts.pdf", sizeBytes: 500,
  status: { state: "transferring", bytesTransferred: 240 } };
const folder = { peerId: file.peerId, id: file.id, title: "Tidal charts", sizeBytes: 2_000,
  status: { state: "transferring", bytesTransferred: 1600 } };

test("only in-progress incoming Private Remote bytes cross the island adapter", async () => {
  const { incomingRemoteIslandTransfers } = await import("../../apps/aerift/src/windows/private-remote-island.ts");
  const inactive = ["pending", "accepted", "completed", "rejected", "cancelled", "failed"];
  const result = incomingRemoteIslandTransfers(
    [...inactive.map(state => ({ ...file, status: { ...file.status, state } })), file],
    [folder, { ...folder, status: { state: "completed", bytesTransferred: 2000 } }],
  );
  assert.deepEqual(result.map(({ id, ...info }) => info), [
    { direction: "incoming", kind: "file", state: "transferring", file: { name: "Tidal charts.pdf", sizeBytes: 500 }, bytesTransferred: 240 },
    { direction: "incoming", kind: "folder", state: "transferring", file: { name: "Tidal charts", sizeBytes: 2000 }, bytesTransferred: 1600 },
  ]);
  assert.notEqual(result[0].id, result[1].id, "independent lanes do not collide even if the named peer and offer ID match");
});

test("unknown or malformed byte records cannot manufacture progress", async () => {
  const { incomingRemoteIslandTransfers } = await import("../../apps/aerift/src/windows/private-remote-island.ts");
  const invalid = [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 501]
    .map(bytesTransferred => ({ ...file, status: { ...file.status, bytesTransferred } }));
  assert.deepEqual(incomingRemoteIslandTransfers([...invalid, { ...file, sizeBytes: NaN }], [
    { ...folder, status: { state: "verified", bytesTransferred: 1600 } },
  ]), []);
  const empty = incomingRemoteIslandTransfers([{ ...file, sizeBytes: 0, status: { ...file.status, bytesTransferred: 0 } }], []);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].file.sizeBytes, 0);
});

test("Remote mode mounts only for a fresh product receive snapshot and shares the existing folder inspector", () => {
  const mode = read("apps/aerift/src/windows/PrivateRemoteDev.tsx");
  assert.match(mode, /incomingRemoteIslandTransfers\(snapshot\?\.offers \?\? \[\], snapshot\?\.foldersActive \? folderOffers : \[\]\)/);
  assert.match(mode, /product && <TransferIsland transfers=\{islandTransfers\} suppressed=\{!active \|\| !fresh\}/);
  const folderMode = read("apps/aerift/src/windows/PrivateRemoteFolders.tsx");
  assert.equal(folderMode.match(/useVisibleNativeRefresh\("/g)?.length, 1);
  assert.match(folderMode, /Save verified folder without replacing files/);
  const island = read("packages/ui/src/TransferIsland.tsx");
  assert.match(island, /sending \? "Recipient checking staged bytes · export is separate" : "Checking staged bytes · save separately"/);
});
