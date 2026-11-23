import { decodeObject, type DigitalObject } from "@aerift/app-contract/digital-objects";

export type MobileObject = Extract<DigitalObject, { kind: "note" | "text" | "url" | "collection" }>;

export const objectStorageKey = "aerift.ios.objects.v1";
export const noteAttachmentStorageKey = "aerift.ios.note-attachments.v1";
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

export function readMobileObjects(storage: Pick<Storage, "getItem">): MobileObject[] | undefined {
  const objects = decodeMobileObjects(storage.getItem(objectStorageKey) ?? "[]");
  const raw = storage.getItem(noteAttachmentStorageKey);
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

export function persistMobileObjects(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  previous: readonly MobileObject[], next: readonly MobileObject[]) {
  // Older builds strictly decode this key. Keep the note text readable after a downgrade.
  const legacy = next.map(object => {
    if (object.kind !== "note") return object;
    const { attachmentIds: _attachmentIds, ...note } = object;
    return note;
  });
  const previousIndex = serializeAttachmentIndex(previous);
  const nextIndex = serializeAttachmentIndex(next);
  if (previousIndex === nextIndex) {
    storage.setItem(objectStorageKey, JSON.stringify(legacy));
    return;
  }

  const storedIndex = storage.getItem(noteAttachmentStorageKey);
  storage.setItem(noteAttachmentStorageKey, nextIndex);
  try {
    storage.setItem(objectStorageKey, JSON.stringify(legacy));
  } catch (error) {
    if (storedIndex === null) storage.removeItem(noteAttachmentStorageKey);
    else storage.setItem(noteAttachmentStorageKey, storedIndex);
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

export function portableText(object: Exclude<MobileObject, { kind: "collection" }>) {
  const extension = object.kind === "note" && object.format === "markdown" ? "md" : "txt";
  const slug = object.name.normalize("NFKD").replace(/[^a-z0-9 -]/gi, "").trim().slice(0, 72);
  return {
    name: `AeRift - ${slug || "Object"}.${extension}`,
    text: object.kind === "url" ? object.url : object.text,
  };
}
