import test from "node:test";
import assert from "node:assert/strict";
import {
  changePhotoAlbums, emptyPhotoAlbumIndex, forgetPhotoReferences, listAlbumPhotos, listRecentPhotos,
  loadPhotoAlbumIndex, recordPhotoImports, savePhotoAlbumIndex, photoAlbumStorageKey,
} from "../../apps/aerift/src/workspace-photo-albums.ts";
const catalog = [
  { id: "old", importedAt: 50, name: "Old.jpg" }, { id: "undated", name: "Undated.jpg" },
  { id: "newest", name: "Newest.jpg" }, { id: "new", name: "New.jpg" },
];
const ids = new Set(catalog.map(item => item.id));
const describe = item => item;
const map = new Map();
const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
const mutate = (index, change) => changePhotoAlbums(index, change, ids);
const create = () => mutate(emptyPhotoAlbumIndex(), { type: "create", id: "family", name: " Family " });

test("user album changes only manipulate local opaque references", () => {
  let value = create();
  value = mutate(value, { type: "add-photo", albumId: "family", photoId: "new" });
  assert.deepEqual(listAlbumPhotos(value, "family", catalog, describe), [catalog[3]]);
  assert.equal(mutate(value, { type: "add-photo", albumId: "family", photoId: "other" }), null);
  assert.equal(mutate(value, { type: "add-photo", albumId: "family", photoId: "new" }), null);
  assert.equal(mutate(value, { type: "create", id: "duplicate", name: "fAmIlY" }), null);
  value = mutate(value, { type: "rename", albumId: "family", name: "Archive" });
  assert.equal(value.albums[0].name, "Archive");
  const removed = mutate(value, { type: "remove", albumId: "family" });
  assert.deepEqual(removed.albums, []);
  assert.equal(catalog[3].name, "New.jpg");
  assert.equal(value.albums[0].photoIds[0], "new");
});

test("recents reflects explicit import timestamps, keeps originals, and preserves stable undated order", () => {
  const initial = emptyPhotoAlbumIndex();
  const recent = recordPhotoImports(recordPhotoImports(initial, ["new", "new"], 100), ["newest", "new"], 200);
  assert.deepEqual(listRecentPhotos(recent, catalog, describe).map(x => x.id), ["newest", "new", "old", "undated"]);
  assert.equal(initial.recents.length, 0);
  assert.deepEqual(recordPhotoImports(initial, ["new"], -1), initial);
  assert.deepEqual(listRecentPhotos(recent, catalog.slice(0, 2), describe), catalog.slice(0, 2));
});

test("desktop, iOS and Android storage cannot cross; sanitized schema rejects native paths and hostile input", () => {
  map.clear();
  const value = recordPhotoImports(mutate(create(), { type: "add-photo", albumId: "family", photoId: "new" }), ["new"], 70);
  assert.equal(savePhotoAlbumIndex(storage, "desktop", value), true);
  assert.deepEqual(loadPhotoAlbumIndex(storage, "desktop"), value);
  for (const scope of ["ios", "android"]) assert.deepEqual(loadPhotoAlbumIndex(storage, scope), emptyPhotoAlbumIndex());
  map.set(photoAlbumStorageKey("ios"), JSON.stringify({ version: 1, albums: [{ id: "family", name: "Album", photoIds: ["C:\\photo.jpg"] }], recents: [] }));
  assert.deepEqual(loadPhotoAlbumIndex(storage, "ios"), emptyPhotoAlbumIndex());
  map.set(photoAlbumStorageKey("ios"), JSON.stringify({ ...value, arbitraryPath: "/native" }));
  assert.deepEqual(loadPhotoAlbumIndex(storage, "ios"), emptyPhotoAlbumIndex());
  assert.equal(savePhotoAlbumIndex({ setItem() { throw Error(); } }, "ios", value), false);
});

test("known removed media is pruned only on explicit deletion; absent catalog items never become visible", () => {
  const value = recordPhotoImports(mutate(create(), { type: "add-photo", albumId: "family", photoId: "new" }), ["new"], 70);
  assert.deepEqual(listAlbumPhotos(value, "family", [], describe), []);
  assert.deepEqual(value.albums[0].photoIds, ["new"]);
  const next = forgetPhotoReferences(value, ["new"]);
  assert.deepEqual(next.albums[0].photoIds, []);
  assert.deepEqual(next.recents, []);
});

test("album colors and icons are validated; legacy records get safe defaults", () => {
  map.clear();
  map.set(photoAlbumStorageKey("ios"), JSON.stringify({
    version: 1, albums: [{ id: "family", name: "Album", photoIds: [] }], recents: [],
  }));
  const legacy = loadPhotoAlbumIndex(storage, "ios");
  assert.equal(legacy.albums[0].color, "default");
  assert.equal(legacy.albums[0].icon, "camera");
  const color = mutate(legacy, { type: "style", albumId: "family", color: "rose" });
  const both = mutate(color, { type: "rename", albumId: "family", name: "Favs", icon: "heart" });
  assert.equal(both.albums[0].color, "rose");
  assert.equal(both.albums[0].icon, "heart");
  assert.equal(mutate(both, { type: "style", albumId: "family", icon: "javascript:alert(1)" }), null);
  assert.equal(mutate(both, { type: "create", id: "invalid", name: "Invalid", color: "rgb(1 2 3)" }), null);
  assert.equal(savePhotoAlbumIndex(storage, "ios", both), true);
  assert.deepEqual(loadPhotoAlbumIndex(storage, "ios"), both);
});
