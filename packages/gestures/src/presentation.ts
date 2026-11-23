import type { GestureFeedback, GestureTarget } from "./intent.js";

export type GestureInteractionPhase = "listening" | "hand-detected" | "ready-to-grasp" |
  "grasping" | "held" | "released" | "interrupted" | "canceled" | "failed";

interface GesturePresentation {
  state: GestureInteractionPhase | "inactive" | "permission" | "activating" |
    "permission-denied" | "unavailable" | "busy" | "offered" | "accepted";
  phase?: GestureInteractionPhase;
  message: string;
}

/** Translate the recognizer's feedback without changing its command or timing semantics. */
export function presentGesture(feedback: GestureFeedback, direction: GestureTarget["kind"]): GesturePresentation {
  const { camera, phase, interruption, posture, message } = feedback;
  if (phase === "released") {
    return { state: "released", phase: "released", message: direction === "send" ? "Offering the file…" : "Accepting the offer…" };
  }
  if (interruption === "cancelled") return { state: "canceled", phase: "canceled", message: "Gesture canceled." };
  if (interruption) return { state: "interrupted", phase: "interrupted", message };

  switch (camera) {
    case "requesting": return { state: "permission", message };
    case "starting": return { state: "activating", message };
    case "denied": return { state: "permission-denied", phase: "failed", message };
    case "unavailable": return { state: "unavailable", phase: "failed", message };
    case "busy": return { state: "busy", phase: "failed", message };
    case "error": return { state: "failed", phase: "failed", message };
    case "suspended": return { state: "interrupted", phase: "interrupted", message };
    case "disabled": return { state: "inactive", message };
    case "ready": break;
  }

  switch (phase) {
    case "acquiring": return posture === "unusable"
      ? { state: "listening", phase: "listening", message: "Raise one open hand." }
      : { state: "hand-detected", phase: "hand-detected", message: "Hand detected. Hold your palm open briefly." };
    case "ready": return { state: "ready-to-grasp", phase: "ready-to-grasp", message: "Close your hand to grasp." };
    case "grasping": return { state: "grasping", phase: "grasping", message };
    case "held": return {
      state: "held", phase: "held",
      message: direction === "send" ? "File held. Open your hand to send." : "Offer held. Open your hand to accept.",
    };
    case "interrupted": return { state: "interrupted", phase: "interrupted", message };
  }
}
