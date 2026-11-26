export type PhotoAlbumScope = "desktop" | "ios" | "android";
export type PhotoAlbumColor = "default" | "blue" | "violet" | "rose" | "amber" | "mint";
export type PhotoAlbumIcon = "folder" | "star" | "heart" | "camera" | "note" | "globe";

export interface PhotoAlbumVisual { color?: PhotoAlbumColor; icon?: PhotoAlbumIcon }
export interface PhotoAlbum {
  id: string;
  name: string;
  color: PhotoAlbumColor;
  icon: PhotoAlbumIcon;
  photoIds: readonly string[];
}
export interface PhotoAlbumIndex {
  version: 1;
  albums: readonly PhotoAlbum[];
  recents: readonly { photoId: string; importedAt: number }[];
}
export interface PhotoCatalogReference { id: string; importedAt?: number }
type StorageRead = Pick<Storage, "getItem">;
type StorageWrite = Pick<Storage, "getItem" | "setItem">;

export type PhotoAlbumChange =
  | ({ type: "create"; id: string; name: string } & PhotoAlbumVisual)
  | ({ type: "rename"; albumId: string; name: string } & PhotoAlbumVisual)
  | ({ type: "style"; albumId: string } & PhotoAlbumVisual)
  | { type: "remove"; albumId: string }
  | { type: "add-photo" | "remove-photo"; albumId: string; photoId: string };

export const photoAlbumNameLimit = 80;
const albumLimit = 80;
const photoLimit = 800;
const recentLimit = 1200;
const maxSerializedLength = 512 * 1024;
const scopes = new Set<PhotoAlbumScope>(["desktop", "ios", "android"]);
const colors = new Set<unknown>(["default", "blue", "violet", "rose", "amber", "mint"]);
const icons = new Set<unknown>(["folder", "star", "heart", "camera", "note", "globe"]);
type UnknownRecord = Record<string, unknown>;

// All current catalog IDs use UUID/hex style tokens. Reject path separators,
// URI syntax, whitespace, and dots rather than accidentally persisting a path.
function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function normalizeName(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return;
  const next = value.trim().replace(/\s+/gu, " ");
  if (next.length && next.length <= photoAlbumNameLimit) return next;
}
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}
function isObject(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function only(value: UnknownRecord, keys: readonly string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}
function validVisual(visual: { color?: unknown; icon?: unknown }) {
  return (visual.color === undefined || colors.has(visual.color)) &&
    (visual.icon === undefined || icons.has(visual.icon));
}
function nameKey(value: string) { return value.toLowerCase(); }

export const emptyPhotoAlbumIndex = (): PhotoAlbumIndex => ({ version: 1, albums: [], recents: [] });

export function photoAlbumStorageKey(scope: PhotoAlbumScope) {
  if (!scopes.has(scope)) throw new TypeError("Unknown Photos catalog scope");
  return `aerift.workspace.photos.albums.v1:${scope}`;
}

function decodeIndex(value: unknown): PhotoAlbumIndex | undefined {
  if (!isObject(value) || !only(value, ["version", "albums", "recents"]) || value.version !== 1 ||
      !Array.isArray(value.albums) || value.albums.length > albumLimit ||
      !Array.isArray(value.recents) || value.recents.length > recentLimit) return;
  const albums: PhotoAlbum[] = [];
  const albumIds = new Set<string>();
  const names = new Set<string>();
  for (const item of value.albums) {
    if (!isObject(item) || !only(item, ["id", "name", "color", "icon", "photoIds"]) ||
        !isOpaqueId(item.id) || albumIds.has(item.id) || !validVisual(item) ||
        !Array.isArray(item.photoIds) || item.photoIds.length > photoLimit ||
        !item.photoIds.every(isOpaqueId) || new Set(item.photoIds).size !== item.photoIds.length) return;
    const name = normalizeName(item.name);
    if (!name || names.has(nameKey(name))) return;
    names.add(nameKey(name));
    albumIds.add(item.id);
    albums.push({ id: item.id, name, color: (item.color ?? "default") as PhotoAlbumColor,
      icon: (item.icon ?? "camera") as PhotoAlbumIcon, photoIds: item.photoIds });
  }
  const imported = new Set<string>();
  const recents: PhotoAlbumIndex["recents"][number][] = [];
  for (const row of value.recents) {
    if (!isObject(row) || !only(row, ["photoId", "importedAt"]) || !isOpaqueId(row.photoId) ||
        !isTimestamp(row.importedAt) || imported.has(row.photoId)) return;
    imported.add(row.photoId);
    recents.push({ photoId: row.photoId, importedAt: row.importedAt });
  }
  return { version: 1, albums, recents };
}

export function loadPhotoAlbumIndex(storage: StorageRead | undefined, scope: PhotoAlbumScope): PhotoAlbumIndex {
  try {
    const text = storage?.getItem(photoAlbumStorageKey(scope));
    if (text && text.length <= maxSerializedLength) return decodeIndex(JSON.parse(text)) ?? emptyPhotoAlbumIndex();
  } catch { /* Storage may be unavailable or contain invalid data. */ }
  return emptyPhotoAlbumIndex();
}

export function savePhotoAlbumIndex(storage: StorageWrite | undefined, scope: PhotoAlbumScope, index: PhotoAlbumIndex) {
  if (!storage) return false;
  try {
    const previous = storage.getItem(photoAlbumStorageKey(scope));
    if (previous !== null && (previous.length > maxSerializedLength || !decodeIndex(JSON.parse(previous)))) return false;
    const decoded = decodeIndex(index);
    if (!decoded) return false;
    const text = JSON.stringify(decoded);
    if (text.length > maxSerializedLength) return false;
    storage.setItem(photoAlbumStorageKey(scope), text);
    return true;
  } catch { return false; }
}

export function changePhotoAlbums(
  index: PhotoAlbumIndex, change: PhotoAlbumChange, knownPhotoIds: ReadonlySet<string>,
): PhotoAlbumIndex | null {
  if (change.type === "create") {
    const name = normalizeName(change.name);
    if (!name || !isOpaqueId(change.id) || !validVisual(change) || index.albums.length >= albumLimit ||
        index.albums.some(album => album.id === change.id || nameKey(album.name) === nameKey(name))) return null;
    return { ...index, albums: [...index.albums, {
      id: change.id, name, color: change.color ?? "default", icon: change.icon ?? "camera", photoIds: [],
    }] };
  }

  const current = index.albums.find(album => album.id === change.albumId);
  if (!current) return null;
  if (change.type === "remove") {
    return { ...index, albums: index.albums.filter(album => album.id !== change.albumId) };
  }
  let updated: PhotoAlbum;
  if (change.type === "rename" || change.type === "style") {
    const name = change.type === "rename" ? normalizeName(change.name) : current.name;
    if (!name || !validVisual(change) || index.albums.some(album =>
      album.id !== current.id && nameKey(album.name) === nameKey(name))) return null;
    updated = { ...current, name, color: change.color ?? current.color, icon: change.icon ?? current.icon };
    if (updated.name === current.name && updated.color === current.color && updated.icon === current.icon) return null;
  } else {
    const has = current.photoIds.includes(change.photoId);
    if (change.type === "add-photo" ? has || !isOpaqueId(change.photoId) ||
        !knownPhotoIds.has(change.photoId) || current.photoIds.length >= photoLimit : !has) return null;
    updated = { ...current, photoIds: change.type === "add-photo" ? [...current.photoIds, change.photoId] :
      current.photoIds.filter(id => id !== change.photoId) };
  }
  return { ...index, albums: index.albums.map(album => album.id === updated.id ? updated : album) };
}

// Call only for explicitly confirmed imports. Browsing or presenting a photo
// never updates this index. A repeated import notice for the same ID is inert.
export function recordPhotoImports(index: PhotoAlbumIndex, ids: readonly string[], importedAt: number): PhotoAlbumIndex {
  if (!isTimestamp(importedAt)) return index;
  const seen = new Set(index.recents.map(entry => entry.photoId));
  const added: PhotoAlbumIndex["recents"][number][] = [];
  for (const photoId of ids) {
    if (!isOpaqueId(photoId) || seen.has(photoId)) continue;
    seen.add(photoId);
    added.push({ photoId, importedAt });
    if (added.length >= recentLimit) break;
  }
  if (!added.length) return index;
  return { ...index, recents: [...added, ...index.recents].sort((a, b) => b.importedAt - a.importedAt).slice(0, recentLimit) };
}

// Call only after confirmed library removal; an incomplete catalog must not
// destroy existing references. This function does not modify the catalog.
export function forgetPhotoReferences(index: PhotoAlbumIndex, removedIds: readonly string[]): PhotoAlbumIndex {
  const removed = new Set(removedIds);
  return { ...index, albums: index.albums.map(album => ({
    ...album, photoIds: album.photoIds.filter(id => !removed.has(id)),
  })), recents: index.recents.filter(entry => !removed.has(entry.photoId)) };
}

export function listRecentPhotos<T>(
  index: PhotoAlbumIndex, catalog: readonly T[], describe: (photo: T) => PhotoCatalogReference,
): T[] {
  const times = new Map(index.recents.map(entry => [entry.photoId, entry.importedAt]));
  const seen = new Set<string>();
  const ordered: { photo: T; time: number }[] = [];
  for (const photo of catalog) {
    const { id, importedAt } = describe(photo);
    if (!isOpaqueId(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push({ photo, time: times.get(id) ?? (isTimestamp(importedAt) ? importedAt : -1) });
  }
  return ordered.sort((a, b) => b.time - a.time).map(entry => entry.photo);
}

export function listAlbumPhotos<T>(
  index: PhotoAlbumIndex, albumId: string, catalog: readonly T[], describe: (photo: T) => PhotoCatalogReference,
): T[] {
  const album = index.albums.find(item => item.id === albumId);
  if (!album) return [];
  const photos = new Map<string, { value: T }>();
  for (const value of catalog) {
    const { id } = describe(value);
    if (isOpaqueId(id) && !photos.has(id)) photos.set(id, { value });
  }
  return album.photoIds.flatMap(id => {
    const photo = photos.get(id);
    return photo ? [photo.value] : [];
  });
}
