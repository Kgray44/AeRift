import { decodeObject, type DigitalObject } from "@aerift/app-contract/digital-objects";

export type MobileObject = Extract<DigitalObject, { kind: "note" | "text" | "url" | "collection" }>;

export const objectStorageKey = "aerift.ios.objects.v1";
export const noteAttachmentStorageKey = "aerift.ios.note-attachments.v1";
const defaultStorageKeys = { objects: objectStorageKey, noteAttachments: noteAttachmentStorageKey };

export const maxObjectCount = 100;
export const maxStoreLength = 512 * 1024;
export const maxTextLength = 24_000;

export function decodeMobileObjects(raw: string): MobileObject[] | undefined {
  if (raw.length > maxStoreLength) return undefined;
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > maxObjectCount) return undefined;
    const result: MobileObject[] = [];
    const ids = new Set<string>();
    for (const entry of entries) {
      const object = decodeObject(JSON.stringify(entry));
      if (!object || object.ownership !== "local" || ids.has(object.id) ||
          (object.kind !== "note" && object.kind !== "text" && object.kind !== "url" && object.kind !== "collection")) {
        return undefined;
      }
      ids.add(object.id);
      result.push(object);
    }
    const itemIds = new Set(result.filter(item => item.kind !== "collection").map(item => item.id));
    return result.some(item => item.kind === "collection" && item.itemIds.some(id => !itemIds.has(id))) ? undefined : result;
  } catch {
    return undefined;
  }
}

export function readMobileObjects(storage: Pick<Storage, "getItem">, keys = defaultStorageKeys): MobileObject[] | undefined {
  const objects = decodeMobileObjects(storage.getItem(keys.objects) ?? "[]");
  const raw = storage.getItem(keys.noteAttachments);
  if (!objects || raw === null || raw.length > maxStoreLength) return objects;

  let index: unknown;
  try {
    index = JSON.parse(raw);
  } catch {
    return objects;
  }
  if (!Array.isArray(index) || index.length > maxObjectCount) return objects;
  const references = new Map<string, unknown>();
  for (const record of index) {
    if (Array.isArray(record) && record.length === 2 && typeof record[0] === "string") {
      references.set(record[0], record[1]);
    }
  }
  return objects.map(object => {
    if (object.kind !== "note" || !references.has(object.id)) return object;
    const attached = decodeObject(JSON.stringify({ ...object, attachmentIds: references.get(object.id) }));
    return attached?.kind === "note" && attached.ownership === "local" ? attached : object;
  });
}

function serializeAttachmentIndex(objects: readonly MobileObject[]): string {
  return JSON.stringify(objects.flatMap(object => object.kind === "note" && object.attachmentIds?.length
    ? [[object.id, object.attachmentIds]] : []));
}

function noteTextRecord(object: MobileObject): MobileObject {
  if (object.kind !== "note") return object;
  const { attachmentIds: _attachmentIds, ...note } = object;
  return note;
}

export function persistMobileObjects(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  previous: readonly MobileObject[], next: readonly MobileObject[], keys = defaultStorageKeys) {
  // Older builds strictly decode this key. Keep the note text readable after a downgrade.
  const legacy = next.map(noteTextRecord);
  const previousIndex = serializeAttachmentIndex(previous);
  const nextIndex = serializeAttachmentIndex(next);
  if (previousIndex === nextIndex) {
    storage.setItem(keys.objects, JSON.stringify(legacy));
    return;
  }

  const storedIndex = storage.getItem(keys.noteAttachments);
  storage.setItem(keys.noteAttachments, nextIndex);
  try {
    storage.setItem(keys.objects, JSON.stringify(legacy));
  } catch (error) {
    if (storedIndex === null) storage.removeItem(keys.noteAttachments);
    else storage.setItem(keys.noteAttachments, storedIndex);
    throw error;
  }
}

export function removeMobileObject(objects: readonly MobileObject[], id: string): MobileObject[] {
  return objects.filter(item => item.id !== id).map(item => item.kind === "collection" && item.itemIds.includes(id)
    ? { ...item, itemIds: item.itemIds.filter(member => member !== id) }
    : item);
}

export function normalWebUrl(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const input = value.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password &&
        url.href.length <= 4000) return url.href;
  } catch {
    return undefined;
  }
}

export interface BrowserLink {
  url: string;
  title?: string | null;
}

export function addBrowserLinks(
  objects: readonly MobileObject[], captures: readonly BrowserLink[], createId: () => string,
): MobileObject[] {
  const seen = new Set(objects.flatMap(object => object.kind === "url" ? [object.url] : []));
  const links: MobileObject[] = [];
  for (const capture of captures) {
    const url = normalWebUrl(capture.url);
    if (!url || seen.has(url)) continue;
    const name = capture.title?.trim().replace(/\s+/g, " ").slice(0, 100) || new URL(url).hostname;
    seen.add(url);
    links.push({ schemaVersion: 1, ownership: "local", id: createId(), kind: "url", url, name });
  }
  return [...links, ...objects];
}

function portableName(name: string, extension: "txt" | "md") {
  const slug = name.normalize("NFKD").replace(/[^a-z0-9 -]/gi, "").trim().slice(0, 72);
  return "AeRift - " + (slug || "Object") + "." + extension;
}

export function portableText(object: Exclude<MobileObject, { kind: "collection" }>) {
  const extension = object.kind === "note" && object.format === "markdown" ? "md" : "txt";
  return {
    name: portableName(object.name, extension),
    text: object.kind === "url" ? object.url : object.text,
  };
}

export function portableCollection(collection: Extract<MobileObject, { kind: "collection" }>,
  objects: readonly MobileObject[]) {
  const entries = new Map(objects.filter(item => item.kind !== "collection").map(item => [item.id, noteTextRecord(item)]));
  const items = collection.itemIds.map(id => entries.get(id));
  if (!items.length || items.some(item => item === undefined)) return undefined;
  const text = JSON.stringify({ schemaVersion: 1, collection, items }, null, 2);
  if (new TextEncoder().encode(text).length > 128 * 1024) return undefined;
  return { name: portableName(collection.name, "txt"), text };
}
