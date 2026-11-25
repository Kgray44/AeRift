import type { Transfer } from "@aerift/app-contract";

export const transferMetricStaleMs = 4_000;
const minimumSampleMs = 250;
const smoothingMs = 1_500;

export interface TransferMetricSample {
  observedBytes: number;
  changedAt: number;
  baselineBytes: number;
  baselineAt: number;
  rate?: number;
}

export function activeIslandTransfers(transfers: readonly Transfer[]) {
  return transfers.filter(transfer => transfer.state === "transferring");
}

function validBytes(bytes: number) {
  return Number.isFinite(bytes) && bytes >= 0;
}

function totalFor(transfer: Transfer) {
  const size = transfer.file.sizeBytes;
  return validBytes(size) && size > 0 ? size : undefined;
}

function observedFor(transfer: Transfer) {
  const received = transfer.bytesTransferred;
  if (!validBytes(received)) return undefined;
  return Math.min(received, totalFor(transfer) ?? Infinity);
}

function initial(bytes: number, now: number): TransferMetricSample {
  return { observedBytes: bytes, changedAt: now, baselineBytes: bytes, baselineAt: now };
}

// These samples describe native I/O, not the cadence of UI renders or receipt polls.
export function observeIslandTransfers(
  previous: ReadonlyMap<string, TransferMetricSample>,
  active: readonly Transfer[],
  now: number,
): ReadonlyMap<string, TransferMetricSample> {
  const next = new Map<string, TransferMetricSample>();
  for (const transfer of active) {
    const bytes = observedFor(transfer);
    if (bytes === undefined || !Number.isFinite(now)) continue;
    const sample = previous.get(transfer.id);
    if (!sample || now < sample.changedAt || bytes < sample.observedBytes) {
      next.set(transfer.id, initial(bytes, now));
      continue;
    }
    if (bytes === sample.observedBytes) {
      next.set(transfer.id, sample);
      continue;
    }
    if (now - sample.changedAt >= transferMetricStaleMs) {
      // Exclude the dead air before a stalled or reconnected stream started advancing again.
      next.set(transfer.id, initial(bytes, now));
      continue;
    }
    const elapsed = now - sample.baselineAt;
    if (elapsed < minimumSampleMs) {
      next.set(transfer.id, { ...sample, observedBytes: bytes, changedAt: now });
      continue;
    }
    const measured = (bytes - sample.baselineBytes) * 1_000 / elapsed;
    const weight = elapsed / (elapsed + smoothingMs);
    const rate = sample.rate === undefined ? measured : sample.rate + weight * (measured - sample.rate);
    if (!Number.isFinite(rate) || rate <= 0) next.set(transfer.id, initial(bytes, now));
    else next.set(transfer.id, { ...initial(bytes, now), rate });
  }
  return next;
}

export function readIslandMetrics(transfer: Transfer, sample: TransferMetricSample | undefined, now: number) {
  const total = totalFor(transfer);
  const bytes = observedFor(transfer);
  if (total === undefined || bytes === undefined) return {};
  const percent = Math.floor(bytes / total * 100);
  if (percent === 100 || sample?.rate === undefined || now - sample.changedAt >= transferMetricStaleMs || now < sample.changedAt) {
    return { percent };
  }
  return { percent, bytesPerSecond: sample.rate, seconds: (total - bytes) / sample.rate };
}

export function transferIslandSummary(active: readonly Transfer[]) {
  const incoming = active.filter(transfer => transfer.direction === "incoming").length;
  const count = active.length;
  let total = 0;
  let bytes = 0;
  for (const transfer of active) {
    const size = totalFor(transfer);
    const observed = observedFor(transfer);
    if (size === undefined || observed === undefined) {
      return { count, incoming, outgoing: count - incoming, percent: undefined };
    }
    total += size;
    bytes += observed;
  }
  return { count, incoming, outgoing: count - incoming,
    percent: Number.isFinite(total) && total > 0 ? Math.floor(bytes / total * 100) : undefined };
}

export function formatIslandRate(bytes: number) {
  if (bytes < 1) return "<1 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  const order = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3)));
  const rate = bytes / 1_000 ** order;
  return `${rate.toLocaleString(undefined, { maximumFractionDigits: order ? 1 : 0 })} ${units[order]}`;
}

export function formatIslandTime(seconds: number) {
  const rounded = Math.max(1, Math.ceil(seconds));
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3_600) return `${Math.floor(rounded / 60)}m ${String(rounded % 60).padStart(2, "0")}s`;
  if (rounded < 86_400) return `${Math.floor(rounded / 3_600)}h ${Math.floor(rounded % 3_600 / 60)}m`;
  return "over 24h";
}
