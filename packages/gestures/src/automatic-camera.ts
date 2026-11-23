import type { GestureFeedback } from "./intent.js";
import type { GestureTransferSelection } from "./send-binding.js";

type Send = { selectionId: string; deviceId: string };
type Offer = { transferId: string; deviceId: string };

export function automaticGestureTarget(intent: Send | null, incoming: readonly Offer[], chosenOffer: string): GestureTransferSelection | null {
  const incomingTarget = (offer: Offer) => ({ kind: "receive" as const, transferId: offer.transferId, deviceId: offer.deviceId });
  if (chosenOffer) {
    const offer = incoming.find(candidate => candidate.transferId === chosenOffer);
    return offer ? incomingTarget(offer) : null;
  }
  if (intent) return { kind: "send", ...intent };
  const [offer] = incoming;
  return incoming.length === 1 && offer ? incomingTarget(offer) : null;
}

export function cameraRecovery(
  feedback: Pick<GestureFeedback, "camera" | "interruption">, reachedReady: boolean, canCheckPermission = false,
) {
  const { camera, interruption } = feedback;
  if (camera === "denied" || camera === "unavailable" || camera === "busy" || camera === "error") return "retry-from-settings";
  if (camera === "suspended" && !interruption) return "wait-for-foreground";
  return reachedReady || (canCheckPermission && interruption === "target-changed") ? "rearm" : "retry-from-settings";
}
