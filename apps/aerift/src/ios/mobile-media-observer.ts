import type { Result } from "@aerift/app-contract";
import type { ImportedMedia, MobileMediaPort } from "./mobile-media";

type Imports = readonly ImportedMedia[];
type Listener = (imports: Imports) => void;

export interface ObservedMediaPort extends MobileMediaPort {
  subscribe(listener: Listener): () => void;
}

// The shell outlives the Files and Photos views. Keep their native import results
// current when a provider finishes while another destination is on screen.
export function observeMobileMedia(port: MobileMediaPort): ObservedMediaPort {
  const listeners = new Set<Listener>();
  let imports: Imports | undefined;
  let revision = 0;
  let mutating = false;

  async function mutate(action: () => Promise<Result<Imports>>): Promise<Result<Imports>> {
    if (mutating) return { ok: false, error: { code: "invalid_request" } };
    mutating = true;
    try {
      const result = await action();
      if (result.ok) {
        imports = result.value;
        revision++;
        for (const listener of listeners) listener(imports);
      }
      return result;
    } finally {
      mutating = false;
    }
  }

  return {
    ...port,
    subscribe(listener) {
      listeners.add(listener);
      if (imports) listener(imports);
      return () => { listeners.delete(listener); };
    },
    async list() {
      const requested = revision;
      const result = await port.list();
      if (revision !== requested && imports) return { ok: true, value: imports };
      if (result.ok) imports = result.value;
      return result;
    },
    import: source => mutate(() => port.import(source)),
    remove: assetId => mutate(() => port.remove(assetId)),
  };
}
