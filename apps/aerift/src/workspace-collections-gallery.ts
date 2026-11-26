import { decodeCategoryStyle, type CategoryStyle } from "./category-style.ts";

export const collectionGalleryTitleLimit = 100;
const categoryLimit = 48;
const recentLimit = 32;
const assignmentLimit = 2_048;

export type CollectionGalleryRow = { id: string; name: string; memberIds: readonly string[] };
type Category = { id: string; name: string; style: CategoryStyle };
type Assignment = { id: string; categoryId: string };
export type CollectionGalleryAppearance = {
  schemaVersion: 1;
  categories: readonly Category[];
  recents: readonly string[];
  assignments: readonly Assignment[];
};
export type CollectionGalleryView = "all" | "recents" | { categoryId: string };
export type CollectionGalleryChange =
  | { type: "putCategory"; id: string; name: string; style: CategoryStyle }
  | { type: "removeCategory"; id: string }
  | { type: "assign"; id: string; categoryId?: string }
  | { type: "visit" | "forget"; id: string };

export function normalizeCollectionTitle(raw: string): string | undefined {
  const title = raw.trim();
  return title && title.length <= collectionGalleryTitleLimit && !/\p{Cc}/u.test(raw) ? title : undefined;
}

export function emptyCollectionGalleryAppearance(): CollectionGalleryAppearance {
  return { schemaVersion: 1, categories: [], recents: [], assignments: [] };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function validId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128 && !/\p{Cc}/u.test(id);
}
function nameKey(name: string) { return name.toLowerCase(); }

export function decodeCollectionGalleryAppearance(raw: unknown, live: ReadonlySet<string>): CollectionGalleryAppearance {
  const parsed = record(raw);
  if (!parsed || parsed.schemaVersion !== 1) return emptyCollectionGalleryAppearance();
  const categories: Category[] = [], recents: string[] = [], assignments: Assignment[] = [];
  const categoryIds = new Set<string>(), names = new Set<string>(), visited = new Set<string>(), assigned = new Set<string>();
  for (const element of Array.isArray(parsed.categories) ? parsed.categories.slice(0, categoryLimit) : []) {
    const item = record(element);
    if (!item || !validId(item.id) || typeof item.name !== "string") continue;
    const name = normalizeCollectionTitle(item.name), style = decodeCategoryStyle(item.style);
    if (!name || !style || categoryIds.has(item.id) || names.has(nameKey(name))) continue;
    categoryIds.add(item.id); names.add(nameKey(name));
    categories.push({ id: item.id, name, style });
  }
  for (const id of Array.isArray(parsed.recents) ? parsed.recents.slice(0, recentLimit) : []) {
    if (validId(id) && live.has(id) && !visited.has(id)) { visited.add(id); recents.push(id); }
  }
  for (const element of Array.isArray(parsed.assignments) ? parsed.assignments.slice(0, assignmentLimit) : []) {
    const item = record(element);
    if (!item || !validId(item.id) || !validId(item.categoryId) || !live.has(item.id) ||
        !categoryIds.has(item.categoryId) || assigned.has(item.id)) continue;
    assigned.add(item.id);
    assignments.push({ id: item.id, categoryId: item.categoryId });
  }
  return { schemaVersion: 1, categories, recents, assignments };
}

export function changeCollectionGallery(current: CollectionGalleryAppearance, action: CollectionGalleryChange,
  live: ReadonlySet<string>): CollectionGalleryAppearance | null {
  if (!validId(action.id)) return null;
  if (action.type === "putCategory") {
    const name = normalizeCollectionTitle(action.name), style = decodeCategoryStyle(action.style);
    if (!name || !style || current.categories.some(item => item.id !== action.id && nameKey(item.name) === nameKey(name))) return null;
    const exists = current.categories.some(item => item.id === action.id);
    if (!exists && current.categories.length >= categoryLimit) return null;
    const item = { id: action.id, name, style };
    return { ...current, categories: exists ? current.categories.map(row => row.id === action.id ? item : row) : [...current.categories, item] };
  }
  if (action.type === "removeCategory") {
    if (!current.categories.some(item => item.id === action.id)) return null;
    return { ...current, categories: current.categories.filter(row => row.id !== action.id),
      assignments: current.assignments.filter(row => row.categoryId !== action.id) };
  }
  if (action.type === "forget") {
    return { ...current, recents: current.recents.filter(id => id !== action.id),
      assignments: current.assignments.filter(item => item.id !== action.id) };
  }
  if (!live.has(action.id)) return null;
  if (action.type === "visit") {
    return { ...current, recents: [action.id, ...current.recents.filter(id => id !== action.id)].slice(0, recentLimit) };
  }
  if (action.type !== "assign") return null;
  const next = current.assignments.filter(item => item.id !== action.id);
  if (action.categoryId === undefined) return { ...current, assignments: next };
  if (next.length >= assignmentLimit || !current.categories.some(item => item.id === action.categoryId)) return null;
  return { ...current, assignments: [...next, { id: action.id, categoryId: action.categoryId }] };
}

export function collectionGalleryRows<T extends CollectionGalleryRow>(entries: readonly T[],
  appearance: CollectionGalleryAppearance, view: CollectionGalleryView, query: string): T[] {
  const words = query.slice(0, collectionGalleryTitleLimit).trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = (entry: T) => words.every(word => entry.name.toLowerCase().includes(word));
  if (view === "all") return entries.filter(matches);
  if (view === "recents") {
    const indexed = new Map(entries.map(entry => [entry.id, entry]));
    return appearance.recents.flatMap(id => {
      const entry = indexed.get(id);
      return entry && matches(entry) ? [entry] : [];
    });
  }
  const members = new Set(appearance.assignments.filter(item => item.categoryId === view.categoryId).map(item => item.id));
  return entries.filter(entry => members.has(entry.id) && matches(entry));
}
