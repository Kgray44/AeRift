import type { FileSelection, Transfer } from "@aerift/app-contract";
import type { TransferIntent } from "./send-action";

export interface WorkspaceGestureFeedback {
  target: ({ kind: "send" } & TransferIntent) | { kind: "receive"; transferId: string; deviceId: string };
  phase: "listening" | "hand-detected" | "ready-to-grasp" | "grasping" | "held" | "released" |
    "interrupted" | "canceled" | "failed";
}

const sequence: Record<Transfer["state"], number> = {
  pending: 0, accepted: 1, transferring: 2, completed: 3, failed: 3, rejected: 3, cancelled: 3,
};

export function isTransferActive(transfer: Transfer) {
  return sequence[transfer.state] < 3;
}

/** The latest snapshot owns membership; each receipt advances monotonically within a subscription. */
export function reconcileTransfers(previous: readonly Transfer[], next: readonly Transfer[]) {
  const prior = new Map(previous.map(receipt => [receipt.id, receipt]));
  const receipts = new Map<string, Transfer>();
  for (const update of next) {
    const current = receipts.get(update.id) ?? prior.get(update.id);
    const advances = !current || (
      isTransferActive(current) && sequence[update.state] >= sequence[current.state] &&
      update.bytesTransferred >= current.bytesTransferred
    );
    receipts.set(update.id, advances ? update : current);
  }
  return [...receipts.values()];
}

export interface RiftAftermath {
  id: string;
  expiresAt: number;
}

/** An update can coalesce the entire lifetime of a newly attempted transfer. */
export function terminalTransition(previous: readonly Transfer[] | undefined, current: readonly Transfer[]) {
  if (!previous) return undefined;
  const settled = new Set(previous.filter(item => !isTransferActive(item)).map(item => item.id));
  return current.find(item => !isTransferActive(item) && !settled.has(item.id));
}

export function selectRift(transfers: readonly Transfer[], aftermath: RiftAftermath | undefined, now: number) {
  return transfers.find(item => item.direction === "incoming" && item.state === "pending") ??
    transfers.find(isTransferActive) ??
    (aftermath && now < aftermath.expiresAt ? transfers.find(item => item.id === aftermath.id) : undefined);
}

export function objectPhase(selection: FileSelection, destinationId: string | undefined,
  gesture: WorkspaceGestureFeedback | undefined) {
  if (gesture?.target.kind !== "send" || selection.selectionId !== gesture.target.selectionId ||
    destinationId !== gesture.target.deviceId) return "resting";
  return engagedObjectPhase(gesture.phase) ?? "resting";
}

export function incomingObjectPhase(transfer: Transfer, gesture: WorkspaceGestureFeedback | undefined) {
  if (transfer.direction !== "incoming" || transfer.state !== "pending" ||
    gesture?.target.kind !== "receive" || gesture.target.transferId !== transfer.id ||
    gesture.target.deviceId !== transfer.deviceId) return undefined;
  return engagedObjectPhase(gesture.phase);
}

function engagedObjectPhase(phase: WorkspaceGestureFeedback["phase"]) {
  switch (phase) {
    case "hand-detected":
    case "ready-to-grasp":
    case "grasping": return "anticipating";
    case "held": return "held";
    case "interrupted":
    case "canceled":
    case "failed": return "recovering";
    default: return undefined;
  }
}

export type ReceiverReadiness = TransferIntent & { expiresAt: number };

export function readinessMatches(ready: ReceiverReadiness | undefined, gesture: WorkspaceGestureFeedback | undefined,
  intent: TransferIntent | null, now: number) {
  return !!ready && gesture?.phase === "held" && gesture.target.kind === "send" && now < ready.expiresAt &&
    intent?.deviceId === ready.deviceId && intent.selectionId === ready.selectionId &&
    gesture.target.deviceId === ready.deviceId && gesture.target.selectionId === ready.selectionId;
}

export function environmentPhase({ transfer, gesture, receiverReady, offering, selected, discovering }: {
  transfer?: Transfer;
  gesture?: "anticipating" | "held" | "recovering" | "resting";
  receiverReady: boolean;
  offering: boolean;
  selected: boolean;
  discovering: boolean;
}) {
  switch (transfer?.state) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled":
    case "rejected": return "interrupted";
    case "accepted":
    case "transferring": return transfer.direction === "incoming" ? "receiving" : "transferring";
  }
  if (offering || (transfer?.state === "pending" && transfer.direction === "outgoing")) return "departure";
  if (receiverReady) return "ready";
  if (gesture === "held") return "held";
  if (gesture === "anticipating") return "hand";
  if (gesture === "recovering") return "interrupted";
  if (selected || transfer) return "selected";
  return discovering ? "discovery" : "idle";
}
