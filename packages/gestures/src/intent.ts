import type { GestureCommand } from "../../app-contract/src/v1.js";
import { MAX_FRAME_GAP_MS, type GestureObservation, type Posture } from "./landmarks.js";

export type CameraState = "disabled" | "requesting" | "starting" | "ready" | "denied" |
  "unavailable" | "busy" | "suspended" | "error";
export type GestureTarget =
  | { kind: "send"; selectionId: string; deviceId: string }
  | { kind: "receive"; transferId: string };
export type Phase = "acquiring" | "ready" | "grasping" | "held" | "released" | "interrupted";

const instructions: Record<Phase, string> = {
  acquiring: "Show one open hand.",
  ready: "Close your hand into a fist.",
  grasping: "Hold the fist briefly.",
  held: "Open your hand to confirm.",
  released: "Gesture confirmed.",
  interrupted: "Gesture cancelled. Start again or use the button.",
};

const cameraInstructions: Partial<Record<CameraState, string>> = {
  disabled: "Camera is off.",
  requesting: "Waiting for camera permission.",
  starting: "Starting hand recognition.",
  denied: "Camera permission was denied. You can still use the button.",
  unavailable: "Camera is unavailable. You can still use the button.",
  busy: "Camera is busy. You can still use the button.",
  suspended: "Camera is paused. Start again when ready.",
  error: "Camera recognition stopped. You can still use the button.",
};

export interface GestureFeedback {
  camera: CameraState;
  phase: Phase;
  posture: Posture;
  confidence: number | null;
  progress: number;
  message: string;
}

type Dispatch = (command: GestureCommand, target: Readonly<GestureTarget>) => void;

/** One user-started attempt against a frozen selection or incoming offer. */
export class GestureIntent {
  private readonly bound: Readonly<GestureTarget>;
  private camera: CameraState = "disabled";
  private phase: Phase = "acquiring";
  private posture: Posture = "unusable";
  private confidence: number | null = null;
  private progress = 0;
  private track: number | null = null;
  private last = -Infinity;
  private armedAt = Infinity;
  private dwell: { posture: Posture; start: number; samples: number } | null = null;

  constructor(private readonly id: string, target: GestureTarget, private readonly dispatch: Dispatch) {
    if (!id || (target.kind === "send" ? !target.selectionId || !target.deviceId : !target.transferId)) {
      throw new Error("Gesture requires a fresh intent and a selected target.");
    }
    this.bound = Object.freeze({ ...target });
  }

  get feedback(): GestureFeedback {
    return {
      camera: this.camera,
      phase: this.phase,
      posture: this.posture,
      confidence: this.confidence,
      progress: this.progress,
      message: this.phase === "released" ? instructions.released :
        cameraInstructions[this.camera] ?? instructions[this.phase],
    };
  }

  setCamera(camera: CameraState): GestureFeedback {
    const wasReady = this.camera === "ready";
    this.camera = camera;
    if (camera !== "ready" && (wasReady || !["requesting", "starting"].includes(camera))) this.cancel();
    return this.feedback;
  }

  updateContext(target: GestureTarget | null): GestureFeedback {
    const bound = this.bound;
    const matches = target?.kind === "send" && bound.kind === "send"
      ? target.deviceId === bound.deviceId && target.selectionId === bound.selectionId
      : target?.kind === "receive" && bound.kind === "receive" && target.transferId === bound.transferId;
    return matches ? this.feedback : this.cancel();
  }

  cancel(): GestureFeedback {
    if (this.active) {
      this.phase = "interrupted";
      this.progress = 0;
      this.dispatch({ version: 1, action: "interrupt", intentId: this.id }, this.bound);
    }
    return this.feedback;
  }

  tick(now: number): GestureFeedback {
    if (this.active && this.phase !== "acquiring" &&
        (now - this.last > MAX_FRAME_GAP_MS || now - this.armedAt > 3000)) return this.cancel();
    return this.feedback;
  }

  observe(observation: GestureObservation, now: number): GestureFeedback {
    if (!this.active || this.camera !== "ready") return this.feedback;
    const { captureMs: at, posture, track, confidence } = observation;
    const fresh = Number.isFinite(now) && Number.isFinite(at) && now - at <= 150 && at <= now + 5 && at > this.last;
    const usable = fresh && track !== null && posture !== "unusable" &&
      (confidence === null || (Number.isFinite(confidence) && confidence >= 0.6 && confidence <= 1));
    const continuous = usable && this.track === track && at - this.last <= MAX_FRAME_GAP_MS;
    this.posture = usable ? posture : "unusable";
    this.confidence = usable ? confidence : null;
    if (!continuous) {
      if (this.phase !== "acquiring") return this.cancel();
      this.dwell = null;
      this.progress = 0;
    }
    if (!usable) return this.feedback;

    this.track = track;
    this.last = at;
    if (now - this.armedAt > 3000) return this.cancel();
    if (this.dwell?.posture !== posture) this.dwell = { posture, start: at, samples: 0 };
    this.dwell.samples++;

    // Crossdeck's three samples and timed dwell per phase. Neutral resets that posture's dwell.
    const acquiring = this.phase === "acquiring";
    const held = this.phase === "held";
    const expected = acquiring || held ? "open" : "fist";
    const dwellMs = acquiring ? 200 : 130;
    this.progress = posture === expected
      ? Math.min((at - this.dwell.start) / dwellMs, this.dwell.samples / 3, 1)
      : 0;
    if (acquiring && this.progress === 1) {
      this.phase = "ready";
      this.armedAt = at;
      this.progress = 0;
    } else if (held && this.progress === 1) {
      this.phase = "released";
      this.dispatch({ version: 1, action: "release", intentId: this.id }, this.bound);
    } else if (!acquiring && !held) {
      this.phase = posture === "fist" ? "grasping" : "ready";
      if (this.progress === 1) {
        this.phase = "held";
        this.progress = 0;
        this.dispatch({ version: 1, action: "arm", intentId: this.id }, this.bound);
      }
    }
    return this.feedback;
  }

  private get active(): boolean {
    return this.phase !== "released" && this.phase !== "interrupted";
  }
}
