import type { CollectionGalleryAppearance } from "./workspace-collections-gallery";

export type CollectionGalleryScope = "desktop" | "ios" | "android";
const maxLength = 256 * 1024;

export function collectionGalleryStorageKey(scope: CollectionGalleryScope) {
  return `aerift.${scope}.workspace.collection-appearance.v1`;
}

export function readCollectionGalleryAppearance(key: string, storage?: Pick<Storage, "getItem">): unknown {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(key);
    return raw && raw.length <= maxLength ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function writeCollectionGalleryAppearance(key: string, value: CollectionGalleryAppearance, storage?: Pick<Storage, "setItem">) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length > maxLength) return false;
    (storage ?? globalThis.localStorage).setItem(key, encoded);
    return true;
  } catch {
    return false;
  }
}
