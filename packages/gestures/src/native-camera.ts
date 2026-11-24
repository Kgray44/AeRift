import { GestureIntent, MAX_ATTEMPT_MS, type CameraState, type GestureFeedback, type GestureInterruption, type GestureTarget } from "./intent.js";
import { HandLandmarkTracker, type LandmarkFrame } from "./landmarks.js";

export type NativeCameraEvent =
  | { type: "state"; attemptId: string; state: CameraState }
  | { type: "frame"; attemptId: string; frame: LandmarkFrame };

export interface NativeCameraPort {
  /** Subscribe before start. Deliver only local observations and camera state. */
  subscribe(listener: (event: NativeCameraEvent) => void): Promise<() => void>;
  /** Return native monotonic milliseconds in the same clock as frame.captureMs. */
  clockMs(): Promise<number>;
  start(attemptId: string): Promise<void>;
  stop(attemptId: string): Promise<void>;
}

/** Bridges a native capture provider to the same gesture and command logic used on Windows. */
export class NativeGestureCamera {
  private started = false;
  private active = false;
  private offset = 0;
  private clockReady = false;
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private attemptTimeout: ReturnType<typeof setTimeout> | undefined;
  private lastFrameAt = -Infinity;
  private readonly tracker = new HandLandmarkTracker();

  constructor(
    private readonly port: NativeCameraPort,
    private readonly attemptId: string,
    private readonly intent: GestureIntent,
    private readonly feedback: (state: GestureFeedback) => void,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.active = true;
    this.intent.begin(performance.now());
    this.attemptTimeout = setTimeout(() => {
      this.publish(this.intent.cancel("attempt-timeout"));
      this.stop();
    }, MAX_ATTEMPT_MS);
    if (this.publish(this.intent.setCamera("requesting"))) return;
    try {
      const unsubscribe = await this.port.subscribe((event) => this.receive(event));
      if (!this.active) return unsubscribe();
      this.unsubscribe = unsubscribe;
      const before = performance.now();
      const native = await this.port.clockMs();
      if (!this.active) return;
      if (!Number.isFinite(native)) throw new Error("Invalid native clock");
      // Earliest possible offset makes frame age conservative, including bridge latency.
      this.offset = before - native;
      this.clockReady = true;
      if (this.intent.feedback.camera === "ready") this.startWatchdog();
      await this.port.start(this.attemptId);
      // Prevent a late start acknowledgement resurrecting a cancelled attempt.
      if (!this.active) await this.port.stop(this.attemptId);
    } catch {
      if (this.active) this.stop("error");
    }
  }

  private startWatchdog(): void {
    // Before ready, the absolute attempt deadline and native startup safety
    // already own teardown. Do not poll an inactive frame source.
    if (!this.active || !this.clockReady || this.timer !== undefined) return;
    let lastFrameAt = Infinity;
    this.timer = setInterval(() => {
      const now = performance.now();
      const result = this.intent.tick(now);
      if (result.phase === "interrupted" || result.phase === "released") {
        this.publish(result);
        return this.stop();
      }
      if (result.camera === "ready") {
        if (lastFrameAt === Infinity) lastFrameAt = now;
        if (now - Math.max(this.lastFrameAt, lastFrameAt) > 750) this.stop("error", "capture-timeout");
      }
    }, 50);
  }

  updateContext(target: GestureTarget | null): void {
    if (this.active && this.publish(this.intent.updateContext(target))) this.stop();
  }

  stop(state: CameraState = "disabled", reason: GestureInterruption | null = null): void {
    this.started = true;
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    clearTimeout(this.attemptTimeout);
    try {
      this.unsubscribe?.();
    } catch {
      state = "error";
    }
    void Promise.resolve().then(() => this.port.stop(this.attemptId)).catch(() => {
      this.publish(this.intent.setCamera("error"));
    });
    this.publish(this.intent.setCamera(state, reason));
  }

  private receive(event: NativeCameraEvent): void {
    if (!this.active || event.attemptId !== this.attemptId) return;
    if (event.type === "state") {
      if (event.state === "ready" || event.state === "starting" || event.state === "requesting") {
        if (this.publish(this.intent.setCamera(event.state))) this.stop(event.state);
        else if (event.state === "ready") this.startWatchdog();
      } else this.stop(event.state);
      return;
    }
    try {
      this.lastFrameAt = performance.now();
      const observation = this.tracker.observe({
        ...event.frame, captureMs: event.frame.captureMs + this.offset,
      });
      if (this.publish(this.intent.observe(observation, this.lastFrameAt))) this.stop();
    } catch {
      this.stop("error");
    }
  }

  private publish(result: GestureFeedback): boolean {
    try {
      this.feedback(result);
    } catch {
      this.stop("error");
      return true;
    }
    return result.phase === "released" || result.phase === "interrupted";
  }
}
