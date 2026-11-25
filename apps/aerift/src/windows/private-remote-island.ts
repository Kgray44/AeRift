import type { TransferIslandReceipt } from "@aerift/ui";

interface IncomingRemoteBase {
  peerId: string;
  id: string;
  sizeBytes: number;
  status: { state: string; bytesTransferred: number };
}
export type IncomingRemoteFile = IncomingRemoteBase & { name: string };
export type IncomingRemoteFolder = IncomingRemoteBase & { title: string };

function project(
  offer: IncomingRemoteBase, label: string, kind: "file" | "folder",
): TransferIslandReceipt | undefined {
  if (offer.status.state !== "transferring") return;
  const bytesTransferred = offer.status.bytesTransferred;
  if (!Number.isSafeInteger(offer.sizeBytes) || offer.sizeBytes < 0 ||
      !Number.isSafeInteger(bytesTransferred) || bytesTransferred < 0 || bytesTransferred > offer.sizeBytes) return;
  return {
    // Keys only identify rows across reads. Never render them or the peer address.
    id: JSON.stringify([kind, offer.peerId, offer.id]), direction: "incoming", kind,
    state: "transferring", file: { name: label, sizeBytes: offer.sizeBytes }, bytesTransferred,
  };
}

/** These statuses describe the provider's receiver, not delivery to an export folder. */
export function incomingRemoteIslandTransfers(
  files: readonly IncomingRemoteFile[], folders: readonly IncomingRemoteFolder[],
): readonly TransferIslandReceipt[] {
  const visible: TransferIslandReceipt[] = [];
  for (const file of files) {
    const receipt = project(file, file.name, "file");
    if (receipt) visible.push(receipt);
  }
  for (const folder of folders) {
    const receipt = project(folder, folder.title, "folder");
    if (receipt) visible.push(receipt);
  }
  return visible;
}
