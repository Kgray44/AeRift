import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transpile } from "typescript";
const source = readFileSync(new URL("../../apps/aerift/src/friends-profile.ts", import.meta.url), "utf8");
const model = await import("data:text/javascript;base64," + Buffer.from(transpile(source, { module: 99, target: 9 })).toString("base64"));
const { emptyFriendProfiles, readFriendProfiles, saveFriendPresentation, friendDisplayName, imageHeader } = model;

function memory() {
  let data;
  return { getItem: () => data ?? null, setItem: (_, value) => { data = value; } };
}
test("names and avatars are scoped to each verified identity and local device", () => {
  const storage = memory();
  saveFriendPresentation(storage, "friend-a", { localName: "Alice", nickname: "Al", avatar: { kind: "glass", value: "prism" } });
  saveFriendPresentation(storage, "self", { localName: "Me", nickname: "", avatar: { kind: "color", value: "violet" } });
  const profiles = readFriendProfiles(storage);
  assert.equal(friendDisplayName("Verified Alice", profiles.people["friend-a"]), "Al");
  assert.equal(friendDisplayName("Verified Bob", profiles.people["friend-b"]), "Verified Bob");
  assert.equal(profiles.self.localName, "Me");
  saveFriendPresentation(storage, "friend-a", { localName: "Alice", nickname: "", avatar: { kind: "initials" } });
  assert.equal(friendDisplayName("Verified Alice", readFriendProfiles(storage).people["friend-a"]), "Alice");
  saveFriendPresentation(storage, "friend-a", { localName: "", nickname: "", avatar: { kind: "initials" } });
  assert.equal(readFriendProfiles(storage).people["friend-a"], undefined);
});
test("persisted values do not load arbitrary URLs, SVG, or unknown styles", () => {
  const storage = memory();
  storage.setItem("unused", JSON.stringify({ self: { localName: "Example", avatar: { kind: "photo", value: "https://example.test/track.jpg" } },
    people: { constructor: { localName: "bad" }, friend: { avatar: { kind: "glass", value: "foreign" } } } }));
  const profile = readFriendProfiles(storage);
  assert.equal(profile.self.avatar.kind, "initials");
  assert.equal(profile.people.constructor, undefined);
  assert.equal(profile.people.friend, undefined);
  assert.equal(Object.keys(emptyFriendProfiles().people).length, 0);
});
test("image admission rejects spoofed and oversized image headers", () => {
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,100,0,0,0,100,8,2,0,0,0,0,0,0,0]);
  assert.deepEqual(imageHeader(png), { type: "image/png", width: 100, height: 100 });
  png[17] = 128;
  assert.equal(imageHeader(png), undefined);
  assert.equal(imageHeader(new TextEncoder().encode("<svg onload='alert(1)'>")), undefined);
});

test("stored canonical JPEG becomes a bounded local blob, not a network URL", async () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 192, 0, 192, 1, 0xff, 0xda, 0, 2, 0xff, 0xd9, 0, 0]);
  const value = "data:image/jpeg;base64," + Buffer.from(jpeg).toString("base64");
  const blob = model.profilePhotoBlob(value);
  assert.equal(blob.type, "image/jpeg");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), jpeg);
  assert.equal(model.profilePhotoBlob("file:///Users/example/Desktop/avatar.jpg"), undefined);
  assert.equal(model.profilePhotoBlob("data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64")), undefined);
});

test("an incompatible profile entry cannot overwrite a successful local save", () => {
  const storage = memory();
  saveFriendPresentation(storage, "friend-a", { localName: "Existing", nickname: "", avatar: { kind: "initials" } });
  assert.throws(() => saveFriendPresentation(storage, "friend-a", { localName: "Invalid", nickname: "", avatar: { kind: "photo", value: "broken" } }));
  assert.equal(readFriendProfiles(storage).people["friend-a"].localName, "Existing");
});
