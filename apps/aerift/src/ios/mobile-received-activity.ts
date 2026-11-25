import type { Transfer } from "@aerift/app-contract";
import type { ReceivedActivityRow } from "../received-activity";
import type { ReceivedCopy } from "./mobile-platform";

const iosKey = /^[a-f0-9]{64}:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const androidKey = /^received-[a-f0-9]{64}$/u;

export function mobileReceivedRows(
  transfers: readonly Transfer[], catalog?: readonly ReceivedCopy[], iosReceipts = false,
): ReceivedActivityRow[] {
  const seen = new Set<string>();
  const verified = (catalog ?? []).slice(0, 256).flatMap(item => {
      if (!item || typeof item.id !== "string" || !(iosReceipts ? iosKey : androidKey).test(item.id)
        || seen.has(item.id) || typeof item.name !== "string" || item.name.length === 0 || item.name.length > 255
        || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) return [];
      seen.add(item.id);
      return [{ id: item.id, name: item.name, sizeBytes: item.sizeBytes }];
  });
  if (catalog && !iosReceipts) return verified;
  return [...verified, ...transfers.flatMap(item => {
    if (item.direction !== "incoming" || item.state !== "completed" || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ id: item.id, name: item.file.name, sizeBytes: item.file.sizeBytes }];
  })];
}
