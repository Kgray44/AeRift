import type { Result } from "@aerift/app-contract";

const byteLimit = 128 * 1024;
const wireLimit = Math.ceil(byteLimit / 3) * 4;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function thumbnailJpeg(value: unknown): Blob | undefined {
  if (typeof value !== "string" || value.length < 8 || value.length > wireLimit ||
      value.length % 4 || !base64.test(value)) return;
  try {
    const decoded = atob(value);
    if (decoded.length < 5 || decoded.length > byteLimit || !decoded.startsWith("\xff\xd8\xff") ||
        !decoded.endsWith("\xff\xd9")) return;
    return new Blob([Uint8Array.from(decoded, code => code.charCodeAt(0))], { type: "image/jpeg" });
  } catch { /* Invalid payloads stay on the local fallback tile. */ }
}

export function createMobileThumbnailReader(load: (assetId: string) => Promise<Result<string>>) {
  let lane: Promise<unknown> = Promise.resolve();
  return (assetId: string, signal?: AbortSignal): Promise<Blob | undefined> => {
    if (!uuid.test(assetId) || signal?.aborted) return Promise.resolve(undefined);
    const blocked = () => signal?.aborted || (typeof document !== "undefined" && document.hidden);
    const requested = lane.then(async () => {
      if (blocked()) return;
      const result = await load(assetId);
      if (!blocked() && result.ok) return thumbnailJpeg(result.value);
    }).catch(() => undefined);
    lane = requested;
    return requested;
  };
}
