import { decodeCategoryStyle, type CategoryStyle } from "./category-style.ts";

/** Presentation metadata only. Note objects and the existing store are unchanged. */
export const desktopNoteLibraryKey = "aerift.desktop.notes-library.v1";
export const desktopNoteCategoryLimit = 24;
export const desktopNoteCategoryNameLimit = 80;
const maxNoteRecords = 2048;
const maxSnapshotCharacters = 512 * 1024;

export interface DesktopNoteCategory {
  readonly id: string;
  readonly name: string;
  readonly appearance?: CategoryStyle;
}

export interface DesktopNoteLibrary {
  readonly categories: readonly DesktopNoteCategory[];
  readonly memberships: Readonly<Record<string, string>>;
  readonly modifiedAt: Readonly<Record<string, string>>;
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

function emptyLibrary(): DesktopNoteLibrary {
  return { categories: [], memberships: {}, modifiedAt: {} };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)
    && !Object.hasOwn(Object.prototype, value) && value !== "prototype";
}

function safeName(value: unknown) {
  if (typeof value !== "string" || value.length > desktopNoteCategoryNameLimit ||
    /[\p{Cc}\p{Bidi_Control}]/u.test(value)) return;
  return value.trim() || undefined;
}

function nameKey(name: string) {
  return name.normalize("NFKC").toLowerCase();
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return;
  const canonical = new Date(parsed).toISOString();
  if (value === canonical || value === canonical.replace(".000Z", "Z")) return canonical;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validate(value: unknown): DesktopNoteLibrary | undefined {
  if (!record(value) || value.schemaVersion !== 1 || Object.keys(value).length !== 4 ||
    !Array.isArray(value.categories) || value.categories.length > desktopNoteCategoryLimit ||
    !record(value.memberships) || !record(value.modifiedAt)) return;
  const membershipKeys = Object.keys(value.memberships);
  const modifiedKeys = Object.keys(value.modifiedAt);
  if (membershipKeys.length > maxNoteRecords || modifiedKeys.length > maxNoteRecords) return;
  const categories: DesktopNoteCategory[] = [];
  const categoryIds = new Set<string>();
  const categoryNames = new Set<string>();
  for (const category of value.categories as unknown[]) {
    if (!record(category) || Object.keys(category).some(key => !["id", "name", "appearance"].includes(key)) || !validId(category.id)) return;
    const appearance = decodeCategoryStyle(category.appearance);
    if (Object.hasOwn(category, "appearance") && !appearance) return;
    const name = safeName(category.name);
    if (!name || categoryIds.has(category.id) || categoryNames.has(nameKey(name))) return;
    categories.push({ id: category.id, name, ...(appearance ? { appearance } : {}) });
    categoryIds.add(category.id);
    categoryNames.add(nameKey(name));
  }
  const memberships: Record<string, string> = {};
  const modifiedAt: Record<string, string> = {};
  for (const id of membershipKeys.sort()) {
    const categoryId = value.memberships[id];
    if (!validId(id) || typeof categoryId !== "string" || !categoryIds.has(categoryId)) return;
    memberships[id] = categoryId;
  }
  for (const id of modifiedKeys.sort()) {
    const modified = timestamp(value.modifiedAt[id]);
    if (!validId(id) || !modified) return;
    modifiedAt[id] = modified;
  }
  return { categories, memberships, modifiedAt };
}

function decode(raw: string): DesktopNoteLibrary | undefined {
  if (raw.length > maxSnapshotCharacters) return;
  try { return validate(JSON.parse(raw)); } catch { return; }
}

export function loadDesktopNoteLibrary(storage?: ReadStorage): DesktopNoteLibrary {
  try {
    const raw = storage?.getItem(desktopNoteLibraryKey);
    return (raw === undefined || raw === null ? undefined : decode(raw)) ?? emptyLibrary();
  } catch {
    return emptyLibrary();
  }
}

function encode(library: DesktopNoteLibrary): string | undefined {
  const validated = validate({ schemaVersion: 1, categories: library.categories, memberships: library.memberships, modifiedAt: library.modifiedAt });
  if (!validated) return;
  const raw = JSON.stringify({ schemaVersion: 1, ...validated });
  return raw.length <= maxSnapshotCharacters ? raw : undefined;
}

/**
 * Persist a complete candidate before adopting it in the UI. Compare the last
 * loaded state when provided; localStorage is not a multi-window lock.
 * Unreadable and future-version data are never overwritten automatically.
 */
export function saveDesktopNoteLibrary(storage: WriteStorage | undefined, library: DesktopNoteLibrary, expected?: DesktopNoteLibrary): boolean {
  if (!storage) return false;
  try {
    const previous = storage.getItem(desktopNoteLibraryKey);
    const decoded = previous === null ? emptyLibrary() : decode(previous);
    const candidate = encode(library);
    if (!decoded || !candidate || (expected && encode(expected) !== encode(decoded))) return false;
    storage.setItem(desktopNoteLibraryKey, candidate);
    return true;
  } catch {
    return false;
  }
}

export function createDesktopNoteCategory(library: DesktopNoteLibrary, id: string, value: string, requestedStyle?: CategoryStyle): DesktopNoteLibrary {
  const name = safeName(value);
  const appearance = decodeCategoryStyle(requestedStyle);
  if (requestedStyle && !appearance) return library;
  if (!validId(id) || !name || library.categories.length >= desktopNoteCategoryLimit ||
    library.categories.some(category => category.id === id || nameKey(category.name) === nameKey(name))) return library;
  return { ...library, categories: [...library.categories, { id, name, ...(appearance ? { appearance } : {}) }] };
}

export function renameDesktopNoteCategory(library: DesktopNoteLibrary, id: string, value: string, requestedStyle?: CategoryStyle): DesktopNoteLibrary {
  const name = safeName(value);
  const appearance = decodeCategoryStyle(requestedStyle);
  if (requestedStyle && !appearance) return library;
  if (!name || !library.categories.some(category => category.id === id && (category.name !== name || (appearance &&
    (category.appearance?.color !== appearance.color || category.appearance?.icon !== appearance.icon)))) ||
    library.categories.some(category => category.id !== id && nameKey(category.name) === nameKey(name))) return library;
  return { ...library, categories: library.categories.map(category => category.id === id ? { ...category, name, ...(appearance ? { appearance } : {}) } : category) };
}

export function removeDesktopNoteCategory(library: DesktopNoteLibrary, id: string): DesktopNoteLibrary {
  if (!library.categories.some(category => category.id === id)) return library;
  return {
    ...library,
    categories: library.categories.filter(category => category.id !== id),
    memberships: Object.fromEntries(Object.entries(library.memberships).filter(([, category]) => category !== id)),
  };
}

export function setDesktopNoteCategory(library: DesktopNoteLibrary, noteId: string, categoryId: string | null): DesktopNoteLibrary {
  if (!validId(noteId)) return library;
  const previous = library.memberships[noteId] ?? null;
  if (previous === categoryId) return library;
  if (categoryId !== null && (!library.categories.some(category => category.id === categoryId) ||
      (previous === null && Object.keys(library.memberships).length >= maxNoteRecords))) return library;
  const memberships = { ...library.memberships };
  if (categoryId === null) delete memberships[noteId];
  else memberships[noteId] = categoryId;
  return { ...library, memberships };
}

export function touchDesktopNote(library: DesktopNoteLibrary, id: string, value: string): DesktopNoteLibrary {
  const modified = timestamp(value);
  if (!validId(id) || !modified) return library;
  const previous = library.modifiedAt[id];
  if (previous ? previous >= modified : Object.keys(library.modifiedAt).length >= maxNoteRecords) return library;
  return { ...library, modifiedAt: { ...library.modifiedAt, [id]: modified } };
}

export function removeDesktopNoteMetadata(library: DesktopNoteLibrary, id: string): DesktopNoteLibrary {
  if (!validId(id) || (!Object.hasOwn(library.memberships, id) && !Object.hasOwn(library.modifiedAt, id))) return library;
  const memberships = { ...library.memberships };
  const modifiedAt = { ...library.modifiedAt };
  delete memberships[id];
  delete modifiedAt[id];
  return { ...library, memberships, modifiedAt };
}

export function sortDesktopNotes<T extends { id: string }>(notes: readonly T[], library: DesktopNoteLibrary): T[];
export function sortDesktopNotes<T>(notes: readonly T[], library: DesktopNoteLibrary, getId: (note: T) => string): T[];
export function sortDesktopNotes<T>(notes: readonly T[], library: DesktopNoteLibrary,
  getId: (note: T) => string = note => (note as { id: string }).id): T[] {
  return notes.map((note, index) => {
    const id = getId(note);
    const value = validId(id) ? library.modifiedAt[id] : undefined;
    return { note, index, time: value ? Date.parse(value) : Number.NEGATIVE_INFINITY };
  }).sort((a, b) => (b.time - a.time) || a.index - b.index).map(value => value.note);
}
