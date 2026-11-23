import { ERROR_CODES, type Transfer } from "@aerift/app-contract";

type TerminalTransfer = Extract<Transfer, { state: "failed" }> | (
  Omit<Transfer, "state"> & { state: "completed" | "cancelled" | "rejected" }
);
const limit = 60;
export const historyStorageKey = "aerift.ios.activity.v1";

export function isTerminalRecord(value: unknown): value is TerminalTransfer {
  if (!value || typeof value !== "object") return false;
  const item = value as Transfer;
  return typeof item.id === "string" && item.id.length > 0 && item.id.length <= 128 &&
    typeof item.deviceId === "string" && item.deviceId.length > 0 && item.deviceId.length <= 128 &&
    (item.direction === "incoming" || item.direction === "outgoing") &&
    !!item.file && typeof item.file.name === "string" && item.file.name.length > 0 && item.file.name.length <= 240 &&
    Number.isSafeInteger(item.file.sizeBytes) && item.file.sizeBytes >= 0 &&
    Number.isSafeInteger(item.bytesTransferred) && item.bytesTransferred >= 0 && item.bytesTransferred <= item.file.sizeBytes &&
    (item.state === "completed" && item.bytesTransferred === item.file.sizeBytes ||
      item.state === "cancelled" || item.state === "rejected" ||
      item.state === "failed" && ERROR_CODES.includes(item.error?.code));
}

export function recordTransfers(previous: readonly TerminalTransfer[], observed: readonly unknown[]): readonly TerminalTransfer[] {
  const ids = new Set(previous.map(item => item.id));
  const added: TerminalTransfer[] = [];
  for (const input of observed) {
    if (!isTerminalRecord(input) || ids.has(input.id)) continue;
    const { id, deviceId, direction, file, bytesTransferred, state } = input;
    const core = { id, deviceId, direction, file: { name: file.name, sizeBytes: file.sizeBytes }, bytesTransferred };
    added.push(state === "failed" ? { ...core, state, error: { code: input.error.code } } : { ...core, state });
    ids.add(id);
    if (added.length >= limit) break;
  }
  return added.length ? [...added, ...previous].slice(0, limit) : previous;
}

export function decodeMobileHistory(raw: string): readonly TerminalTransfer[] {
  if (raw.length > 128 * 1024) return [];
  try {
    const records: unknown = JSON.parse(raw);
    return Array.isArray(records) ? recordTransfers([], records) : [];
  } catch {
    return [];
  }
}

export function withArchivedTransfers(live: readonly Transfer[], archive: readonly TerminalTransfer[]): readonly Transfer[] {
  const liveIds = new Set(live.map(item => item.id));
  return [...live, ...archive.filter(item => !liveIds.has(item.id))];
}
