export const MAX_RECENT_AVATAR_BYTES = 8 * 1024 * 1024;
const MAX_COUNT = 24;
const LEASE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 4_000;
const opaque = /^[A-Za-z0-9_-]{16,128}$/;

export type ReceivedProfileImage = { id: string; label: string };
export type ReceivedProfileImages = {
  list(signal?: AbortSignal): Promise<readonly ReceivedProfileImage[]>;
  open(id: string, signal?: AbortSignal): Promise<Blob>;
  clear(): void;
};
type Lease = ReceivedProfileImage & { grant: string; sizeBytes: number };

/**
 * A future native implementation must list only app-owned, sealed, verified
 * local image receipts, latest first. Grants are opaque and process/profile
 * scoped, not paths and not substitute consent: the host must confirm the
 * exact intentional local selection. Open only pinned non-reparse handles,
 * verify the receipt identity and digest on that same opened file, enforce
 * the budget during the read, and send no bytes on any failure. JavaScript
 * limits below are additional safeguards, not a native authorization boundary.
 */
export type VerifiedReceivedProfileImageHost = {
  listVerified(query: { maxCount: number; maxBytes: number; signal: AbortSignal }): Promise<readonly Lease[]>;
  openVerified(selection: { id: string; grant: string; maxBytes: number; signal: AbortSignal }): Promise<Blob>;
};

function deadline<T>(work: (signal: AbortSignal) => Promise<T>, time: number, outer?: AbortSignal): Promise<T> {
  if (outer?.aborted) return Promise.reject(Error("Picture selection was canceled."));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(Error("Picture selection was canceled.")); };
    outer?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(Error("The picture request timed out."));
    }, time);
  });
  return Promise.race([Promise.resolve().then(() => {
    if (controller.signal.aborted) throw Error("Picture selection was canceled.");
    return work(controller.signal);
  }), limit]).finally(() => {
    clearTimeout(timer);
    if (cancel) outer?.removeEventListener("abort", cancel);
  });
}

export function recentProfileImages(
  host: VerifiedReceivedProfileImageHost,
  options: { clock?: () => number; timeoutMs?: number } = {},
): ReceivedProfileImages {
  let generation = 0;
  let expiresAt = 0;
  const grants = new Map<string, Lease>();
  const now = options.clock ?? (() => performance.now());
  const timeout = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  function clear() {
    generation++;
    expiresAt = 0;
    grants.clear();
  }

  return {
    clear,
    async list(signal) {
      clear();
      const revision = generation;
      const entries = await deadline(
        requested => host.listVerified({ maxCount: MAX_COUNT, maxBytes: MAX_RECENT_AVATAR_BYTES, signal: requested }),
        timeout, signal,
      );
      if (revision !== generation || signal?.aborted) throw Error("The Inbox list changed. Open it again.");
      const display: ReceivedProfileImage[] = [];
      for (const candidate of entries.slice(0, MAX_COUNT)) {
        if (!candidate || typeof candidate.id !== "string" || typeof candidate.grant !== "string" ||
            !opaque.test(candidate.id) || !opaque.test(candidate.grant) || grants.has(candidate.id) ||
            !Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes <= 0 ||
            candidate.sizeBytes > MAX_RECENT_AVATAR_BYTES || typeof candidate.label !== "string") continue;
        const label = candidate.label.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "").trim().slice(0, 80);
        if (!label) continue;
        grants.set(candidate.id, { id: candidate.id, grant: candidate.grant, sizeBytes: candidate.sizeBytes, label });
        display.push({ id: candidate.id, label });
      }
      expiresAt = now() + LEASE_MS;
      return display;
    },
    async open(id, signal) {
      const selection = grants.get(id);
      if (!selection || now() >= expiresAt || signal?.aborted) throw Error("That picture selection expired. Open the Inbox list again.");
      grants.delete(id);
      const revision = generation;
      const bytes = await deadline(requested => host.openVerified({
        id: selection.id, grant: selection.grant, maxBytes: selection.sizeBytes, signal: requested,
      }), timeout, signal);
      if (revision !== generation || now() >= expiresAt || signal?.aborted ||
          !(bytes instanceof Blob) || bytes.size !== selection.sizeBytes)
        throw Error("The picture no longer matches its approved Inbox entry. Open the list again.");
      return bytes;
    },
  };
}
