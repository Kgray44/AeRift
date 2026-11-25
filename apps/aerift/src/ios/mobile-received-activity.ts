import type { Transfer } from "@aerift/app-contract";
import type { ReceivedActivityRow } from "../received-activity";
import type { ReceivedCopy } from "./mobile-platform";

export function mobileReceivedRows(transfers: readonly Transfer[], catalog?: readonly ReceivedCopy[]): ReceivedActivityRow[] {
  const seen = new Set<string>();
  if (catalog) {
    return catalog.slice(0, 256).flatMap(item => {
      if (!item || typeof item.id !== "string" || !/^received-[a-f0-9]{64}$/u.test(item.id)
        || seen.has(item.id) || typeof item.name !== "string" || item.name.length === 0 || item.name.length > 255
        || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) return [];
      seen.add(item.id);
      return [{ id: item.id, name: item.name, sizeBytes: item.sizeBytes }];
    });
  }
  return transfers.flatMap(item => {
    if (item.direction !== "incoming" || item.state !== "completed" || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ id: item.id, name: item.file.name, sizeBytes: item.file.sizeBytes }];
  });
}
