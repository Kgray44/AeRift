// Local metadata only. No asset bytes, paths, URLs or permissions are stored.
export type GalleryColor = "default" | "blue" | "violet" | "rose" | "amber" | "mint";
export type GalleryIcon = "folder" | "star" | "heart" | "camera" | "note" | "globe";
export type GalleryScope = `${"documents" | "photos"}:${"desktop" | "ios" | "android"}`;
type Visual = { color?: GalleryColor; icon?: GalleryIcon };
export type GalleryCategory = { id: string; name: string; color: GalleryColor; icon: GalleryIcon; ids: readonly string[] };
export type GalleryIndex = { version: 1; categories: readonly GalleryCategory[]; imports: readonly { id: string; at: number }[] };
export type GalleryEntry = { id: string; name: string; importedAt?: number };
export type GalleryEdit =
  | ({ type: "create"; id: string; name: string } & Visual)
  | ({ type: "edit"; categoryId: string; name: string } & Visual)
  | { type: "remove"; categoryId: string }
  | { type: "toggle"; categoryId: string; itemId: string };

const categoryLimit = 80, memberLimit = 800, recentLimit = 1500, storageLimit = 512 * 1024;
export const galleryCategoryNameLimit = 80;
export const gallerySearchLimit = 150;
const colors = new Set<unknown>(["default", "blue", "violet", "rose", "amber", "mint"]);
const icons = new Set<unknown>(["folder", "star", "heart", "camera", "note", "globe"]);
const opaque = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(v);
const validTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const only = (v: object, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
export const emptyGalleryIndex = (): GalleryIndex => ({ version: 1, categories: [], imports: [] });

function nameOf(value: unknown) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return;
  const name = value.trim().replace(/\s+/gu, " ");
  if (name && name.length <= galleryCategoryNameLimit) return name;
}
function validVisual(value: { color?: unknown; icon?: unknown }) {
  return (value.color === undefined || colors.has(value.color)) && (value.icon === undefined || icons.has(value.icon));
}
function keyFor(scope: GalleryScope) {
  if (!/^(documents|photos):(desktop|ios|android)$/u.test(scope)) throw new TypeError("Unknown gallery scope");
  return `aerift.workspace.gallery.v1:${scope}`;
}
function decode(raw: unknown): GalleryIndex | undefined {
  if (!record(raw) || raw.version !== 1 || !only(raw, ["version", "categories", "imports"]) ||
      !Array.isArray(raw.categories) || raw.categories.length > categoryLimit ||
      !Array.isArray(raw.imports) || raw.imports.length > recentLimit) return;
  const idSet = new Set<string>(), names = new Set<string>(), imported = new Set<string>();
  const categories: GalleryCategory[] = [];
  const imports: GalleryIndex["imports"][number][] = [];
  for (const value of raw.categories) {
    if (!record(value) || !only(value, ["id", "name", "color", "icon", "ids"]) || !opaque(value.id) ||
        idSet.has(value.id) || !validVisual(value) || !Array.isArray(value.ids) || value.ids.length > memberLimit ||
        !value.ids.every(opaque) || new Set(value.ids).size !== value.ids.length) return;
    const name = nameOf(value.name);
    if (!name || names.has(name.toLowerCase())) return;
    idSet.add(value.id); names.add(name.toLowerCase());
    categories.push({ id: value.id, name, color: (value.color ?? "default") as GalleryColor,
      icon: (value.icon ?? "folder") as GalleryIcon, ids: value.ids });
  }
  for (const value of raw.imports) {
    if (!record(value) || !only(value, ["id", "at"]) || !opaque(value.id) || imported.has(value.id) || !validTime(value.at)) return;
    imported.add(value.id);
    imports.push({ id: value.id, at: value.at });
  }
  return { version: 1, categories, imports };
}

export function readGalleryIndex(storage: Pick<Storage, "getItem"> | undefined, scope: GalleryScope): GalleryIndex {
  try {
    const text = storage?.getItem(keyFor(scope));
    if (text && text.length <= storageLimit) return decode(JSON.parse(text)) ?? emptyGalleryIndex();
  } catch { /* Storage may be unavailable. */ }
  return emptyGalleryIndex();
}
export function writeGalleryIndex(storage: Pick<Storage, "setItem"> | undefined, scope: GalleryScope, index: GalleryIndex) {
  if (!storage) return false;
  try {
    const safe = decode(index);
    if (!safe) return false;
    const text = JSON.stringify(safe);
    if (text.length > storageLimit) return false;
    storage.setItem(keyFor(scope), text);
    return true;
  } catch { return false; }
}

export function updateGalleryCategory(index: GalleryIndex, edit: GalleryEdit, knownIds: ReadonlySet<string>): GalleryIndex | null {
  if (edit.type === "create") {
    const name = nameOf(edit.name);
    if (!name || !opaque(edit.id) || !validVisual(edit) || index.categories.length >= categoryLimit ||
        index.categories.some(item => item.id === edit.id || item.name.toLowerCase() === name.toLowerCase())) return null;
    return { ...index, categories: [...index.categories, {
      id: edit.id, name, color: edit.color ?? "default", icon: edit.icon ?? "folder", ids: [],
    }] };
  }
  const category = index.categories.find(item => item.id === edit.categoryId);
  if (!category) return null;
  if (edit.type === "remove") return { ...index, categories: index.categories.filter(item => item.id !== category.id) };
  let next: GalleryCategory;
  if (edit.type === "edit") {
    const name = nameOf(edit.name);
    if (!name || !validVisual(edit) || index.categories.some(item => item.id !== category.id &&
        item.name.toLowerCase() === name.toLowerCase())) return null;
    next = { ...category, name, color: edit.color ?? category.color, icon: edit.icon ?? category.icon };
  } else {
    const exists = category.ids.includes(edit.itemId);
    if (!exists && (!opaque(edit.itemId) || !knownIds.has(edit.itemId) || category.ids.length >= memberLimit)) return null;
    next = { ...category, ids: exists ? category.ids.filter(id => id !== edit.itemId) : [...category.ids, edit.itemId] };
  }
  return { ...index, categories: index.categories.map(item => item.id === category.id ? next : item) };
}

// Call only after confirmed imports, not whenever catalog entries appear.
export function recordGalleryImports(index: GalleryIndex, ids: readonly string[], at: number): GalleryIndex {
  if (!validTime(at)) return index;
  const prior = new Set(index.imports.map(item => item.id));
  const added: GalleryIndex["imports"][number][] = [];
  for (const id of ids) {
    if (!opaque(id) || prior.has(id)) continue;
    prior.add(id); added.push({ id, at });
    if (added.length >= recentLimit) break;
  }
  if (!added.length) return index;
  return { ...index, imports: [...added, ...index.imports].sort((a, b) => b.at - a.at).slice(0, recentLimit) };
}

export function forgetGalleryEntry(index: GalleryIndex, id: string): GalleryIndex {
  return { ...index, imports: index.imports.filter(entry => entry.id !== id),
    categories: index.categories.map(category => ({ ...category, ids: category.ids.filter(member => member !== id) })) };
}

export function browseGalleryRows<T extends GalleryEntry>(
  index: GalleryIndex, catalog: readonly T[], categoryId: string | undefined, query: string,
): T[] {
  const words = query.slice(0, gallerySearchLimit).trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const listed = new Map<string, T>();
  for (const row of catalog) {
    if (opaque(row.id) && !listed.has(row.id) && words.every(word => row.name.toLocaleLowerCase().includes(word))) {
      listed.set(row.id, row);
    }
  }
  if (categoryId) {
    const category = index.categories.find(item => item.id === categoryId);
    return category?.ids.flatMap(id => {
      const entry = listed.get(id);
      return entry ? [entry] : [];
    }) ?? [];
  }
  const times = new Map(index.imports.map(item => [item.id, item.at]));
  const time = (row: T) => times.get(row.id) ?? (validTime(row.importedAt) ? row.importedAt : -1);
  return [...listed.values()].sort((a, b) => time(b) - time(a));
}
