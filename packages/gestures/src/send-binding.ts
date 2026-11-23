import { GestureIntent, type GestureTarget } from "./intent.js";

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

export function bindSendGesture(
  id: string,
  readControls: () => SendGestureControls,
  report: (outcome: GestureSendOutcome) => void,
): { intent: GestureIntent; currentTarget: () => GestureTarget | null } | null {
  function currentTarget(): GestureTarget | null {
    const { busy, intent } = readControls();
    return busy || !intent ? null : { kind: "send", ...intent };
  }

  const target = currentTarget();
  if (!target) return null;
  const intent = new GestureIntent(id, target, (command, bound) => {
    if (command.action !== "release" || bound.kind !== "send") return;
    const live = readControls();
    if (live.busy || live.intent?.deviceId !== bound.deviceId ||
        live.intent.selectionId !== bound.selectionId) {
      report("unavailable");
      return;
    }
    // The workspace's Send button uses this same action and synchronous pending guard.
    void (async () => {
      let outcome: GestureSendOutcome;
      try {
        const sent = await live.send({ deviceId: bound.deviceId, selectionId: bound.selectionId });
        outcome = sent ? "sent" : "failed";
      } catch {
        outcome = "failed";
      }
      report(outcome);
    })();
  });

  return { intent, currentTarget };
}
