import { GestureIntent, type GestureTarget } from "./intent.js";
import { automaticGestureTarget } from "./automatic-camera.js";

interface SendIntent {
  readonly deviceId: string;
  readonly selectionId: string;
}

/** The controls supplied to the shared transfer workspace's gesture slot. */
export interface SendGestureControls {
  readonly intent: SendIntent | null;
  readonly busy: boolean;
  send(intent: SendIntent): Promise<boolean>;
}

export type GestureSendOutcome = "sent" | "unavailable" | "failed";

interface ReceiveIntent {
  readonly transferId: string;
  readonly deviceId: string;
}

export type GestureTransferSelection = ({ kind: "send" } & SendIntent) | ({ kind: "receive" } & ReceiveIntent);
export type GestureTransferOutcome = GestureSendOutcome | "accepted";

interface TransferGestureControls extends SendGestureControls {
  readonly incoming?: readonly ReceiveIntent[];
  accept?(intent: ReceiveIntent, chosenOffer?: string): Promise<boolean>;
}

export function bindSendGesture(
  id: string,
  readControls: () => SendGestureControls,
  report: (outcome: GestureSendOutcome) => void,
): { intent: GestureIntent; currentTarget: () => GestureTarget | null } | null {
  const { intent } = readControls();
  return intent && bindTransferGesture(id, { kind: "send", ...intent }, readControls, outcome => {
    if (outcome !== "accepted") report(outcome);
  });
}

export function bindTransferGesture(
  id: string,
  selection: GestureTransferSelection,
  readControls: () => TransferGestureControls,
  report: (outcome: GestureTransferOutcome) => void,
  readChosenOffer?: () => string,
): { intent: GestureIntent; currentTarget: () => GestureTarget | null } | null {
  const frozen = Object.freeze({ ...selection });

  function valid(controls: TransferGestureControls, chosenOffer?: string) {
    if (controls.busy) return false;
    if (chosenOffer !== undefined) {
      const target = automaticGestureTarget(controls.intent, controls.incoming ?? [], chosenOffer);
      if (!target || target.deviceId !== frozen.deviceId) return false;
      if (frozen.kind === "send" && (target.kind !== "send" || target.selectionId !== frozen.selectionId)) return false;
      if (frozen.kind === "receive" && (target.kind !== "receive" || target.transferId !== frozen.transferId)) return false;
    }
    if (frozen.kind === "send") {
      return controls.intent?.deviceId === frozen.deviceId && controls.intent.selectionId === frozen.selectionId;
    }
    return controls.accept && controls.incoming?.some(offer =>
      offer.transferId === frozen.transferId && offer.deviceId === frozen.deviceId);
  }

  function currentTarget(): GestureTarget | null {
    if (!valid(readControls(), readChosenOffer?.())) return null;
    return frozen.kind === "send" ? frozen : { kind: "receive", transferId: frozen.transferId };
  }

  const target = currentTarget();
  if (!target) return null;
  const intent = new GestureIntent(id, target, command => {
    if (command.action !== "release") return;
    const live = readControls();
    const chosenOffer = readChosenOffer?.();
    if (!valid(live, chosenOffer)) {
      report("unavailable");
      return;
    }
    // The workspace's conventional controls use the same actions and pending guards.
    void (async () => {
      let outcome: GestureTransferOutcome;
      try {
        if (frozen.kind === "send") {
          const sent = await live.send({ deviceId: frozen.deviceId, selectionId: frozen.selectionId });
          outcome = sent ? "sent" : "failed";
        } else {
          const accepted = await live.accept?.({ transferId: frozen.transferId, deviceId: frozen.deviceId }, chosenOffer);
          outcome = accepted ? "accepted" : "failed";
        }
      } catch {
        outcome = "failed";
      }
      report(outcome);
    })();
  });

  return { intent, currentTarget };
}
