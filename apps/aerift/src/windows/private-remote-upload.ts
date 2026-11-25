import type { TransferIslandReceipt } from "@aerift/ui";

export type UploadKind = "file" | "folder";

/** Projection of one native invocation. Protocol identity and source path stay native. */
export function projectPrivateRemoteUpload(
  kind: UploadKind, previous: TransferIslandReceipt | undefined, frame: unknown,
): TransferIslandReceipt | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return previous;
  const { state, kind: actual, name, sizeBytes, bytesTransferred } = frame as Record<string, unknown>;
  if (state !== "transferring" || actual !== kind || typeof name !== "string" ||
      name.length === 0 || name.length > 240 || /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(name) ||
      typeof sizeBytes !== "number" || typeof bytesTransferred !== "number" ||
      !Number.isSafeInteger(sizeBytes) || !Number.isSafeInteger(bytesTransferred) ||
      bytesTransferred <= 0 || bytesTransferred > sizeBytes) return previous;
  if (previous && (bytesTransferred <= previous.bytesTransferred ||
      previous.file.name !== name || previous.file.sizeBytes !== sizeBytes)) return previous;
  return {
    id: "private-remote-upload:" + kind, kind, direction: "outgoing", state: "transferring",
    file: { name, sizeBytes }, bytesTransferred,
  };
}
