import { useEffect, useState } from "react";
import { decodeCollectionGalleryAppearance, emptyCollectionGalleryAppearance, type CollectionGalleryAppearance } from "./workspace-collections-gallery";
import { collectionGalleryStorageKey, readCollectionGalleryAppearance, writeCollectionGalleryAppearance, type CollectionGalleryScope } from "./collection-gallery-storage";

export function useCollectionGalleryAppearance(scope: CollectionGalleryScope, ids: readonly string[] | undefined) {
  const [raw, setRaw] = useState<{ scope: CollectionGalleryScope; value: unknown }>();
  useEffect(() => { setRaw({ scope, value: readCollectionGalleryAppearance(collectionGalleryStorageKey(scope)) }); }, [scope]);
  const ready = raw?.scope === scope && ids !== undefined;
  const appearance = ready
    ? decodeCollectionGalleryAppearance(raw.value, new Set(ids))
    : emptyCollectionGalleryAppearance();
  function persist(value: CollectionGalleryAppearance) {
    if (!ready || !writeCollectionGalleryAppearance(collectionGalleryStorageKey(scope), value)) return false;
    setRaw({ scope, value });
    return true;
  }
  return { appearance, persist, ready };
}
