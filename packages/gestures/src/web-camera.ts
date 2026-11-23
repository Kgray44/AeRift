// Capture and worker lifecycle adapted from VoyageWright Reach/Sextant.
import { GestureIntent, type CameraState, type GestureFeedback, type GestureTarget } from "./intent.js";
import { HandLandmarkTracker, type LandmarkFrame } from "./landmarks.js";

interface CameraOptions {
  workerUrl: URL;
  facing?: "user" | "environment";
  deviceId?: string;
  mirrorPreview?: boolean;
}

type WorkerResult =
  | ({ type: "RESULT"; generation: number; capture: number } & Omit<LandmarkFrame, "captureMs">)
  | { type: "READY" | "ERROR"; generation: number };

// A cancelled permission prompt cannot be aborted on all WebViews. Keep the reservation
// until its promise settles and stop any late tracks before allowing a new capture.
const reserved = new WeakMap<MediaDevices, WebGestureCamera>();
const stopTracks = (stream: MediaStream) => stream.getTracks().forEach((track) => track.stop());

export class WebGestureCamera {
  private started = false;
  private active = false;
  private ready = false;
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private media: MediaDevices | null = null;
  private detach = () => {};
  private cleanupTrack = () => {};
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly intent: GestureIntent,
    private readonly video: HTMLVideoElement,
    private readonly feedback: (state: GestureFeedback) => void,
  ) {}

  /** Call directly from an explicit user activation. Create a new instance for each attempt. */
  async start(options: CameraOptions): Promise<void> {
    if (this.started) return;
    this.started = true;
    const media = navigator.mediaDevices;
    if (!globalThis.isSecureContext || !media?.getUserMedia || typeof Worker === "undefined" ||
        typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined" ||
        options.workerUrl.origin !== location.origin ||
        !["http:", "https:"].includes(options.workerUrl.protocol)) return this.stop("unavailable");
    if (document.visibilityState !== "visible") return this.stop("suspended");
    if (reserved.has(media)) return this.stop("busy");

    this.active = true;
    const suspend = () => this.stop("suspended");
    const visibility = () => {
      if (document.visibilityState !== "visible") suspend();
    };
    // Opening the OS permission prompt can blur the page before recognition is ready.
    const blur = () => {
      if (this.ready) suspend();
    };
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("freeze", suspend);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("blur", blur);
    screen.orientation?.addEventListener?.("change", suspend);
    this.detach = () => {
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("freeze", suspend);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("blur", blur);
      screen.orientation?.removeEventListener?.("change", suspend);
    };

    this.publish(this.intent.setCamera("requesting"));
    if (!this.active) return;
    this.timeout(30_000);
    reserved.set(media, this);
    this.media = media;
    try {
      const stream = await media.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 960 },
          ...(options.deviceId ? { deviceId: { exact: options.deviceId } } :
            { facingMode: { ideal: options.facing ?? "user" } }),
        },
      });
      if (!this.active) {
        stopTracks(stream);
        return;
      }
      this.stream = stream;
      const [track, ...others] = stream.getTracks();
      if (!track || others.length || track.kind !== "video" || track.readyState !== "live") {
        this.stop("unavailable");
        return;
      }
      track.addEventListener("ended", suspend);
      track.addEventListener("mute", suspend);
      this.cleanupTrack = () => {
        track.removeEventListener("ended", suspend);
        track.removeEventListener("mute", suspend);
      };
      this.video.playsInline = true;
      this.video.muted = true;
      this.video.style.transform = (options.mirrorPreview ?? options.facing !== "environment") ? "scaleX(-1)" : "";
      this.video.srcObject = stream;
    } catch (error) {
      if (this.active) {
        const name = error instanceof DOMException ? error.name : "";
        this.stop(name === "NotAllowedError" || name === "SecurityError" ? "denied" :
          name === "NotFoundError" || name === "OverconstrainedError" ? "unavailable" :
          name === "NotReadableError" || name === "AbortError" ? "busy" : "error");
      }
      return;
    } finally {
      if (!this.stream && reserved.get(media) === this) reserved.delete(media);
    }

    this.timeout(5_000);
    try {
      await this.video.play();
      if (!this.active) return;
      this.publish(this.intent.setCamera("starting"));
      if (!this.active) return;
      this.timeout(15_000);
      this.runWorker(options.workerUrl);
    } catch {
      if (this.active) this.stop("error");
    }
  }

  updateContext(target: GestureTarget | null): void {
    if (this.active && this.publish(this.intent.updateContext(target))) this.stop();
  }

  /** Call from host deactivation, before changing cameras, and on component disposal. */
  stop(state: CameraState = "disabled"): void {
    this.started = true;
    this.active = false;
    this.ready = false;
    this.detach();
    this.detach = () => {};
    this.cleanupTrack();
    this.cleanupTrack = () => {};
    clearTimeout(this.deadline);
    clearTimeout(this.poll);
    this.worker?.terminate();
    this.worker = null;
    if (this.stream) {
      stopTracks(this.stream);
      if (this.video.srcObject === this.stream) {
        this.video.pause();
        this.video.srcObject = null;
      }
      this.stream = null;
      if (this.media && reserved.get(this.media) === this) reserved.delete(this.media);
    }
    this.publish(this.intent.setCamera(state));
  }

  private timeout(ms: number): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.stop("error"), ms);
  }

  private publish(result: GestureFeedback): boolean {
    try {
      this.feedback(result);
    } catch {
      if (this.active) this.stop("error");
      return true;
    }
    return result.phase === "released" || result.phase === "interrupted";
  }

  private runWorker(url: URL): void {
    const worker = new Worker(url);
    this.worker = worker;
    const tracker = new HandLandmarkTracker();
    const generation = 1; // Worker and tracker are private to this single attempt.
    let mediaTime = -1;
    let capture: number | null = null;
    let lastFrame = performance.now();
    let receivedFrame = false;
    const pump = async () => {
      if (!this.active || this.worker !== worker) return;
      const now = performance.now();
      if (this.intent.tick(now).phase === "interrupted") return this.stop("suspended");
      if (now - lastFrame > (receivedFrame ? 750 : 3_000)) return this.stop("error");
      if (this.video.readyState < 2 || this.video.currentTime === mediaTime) {
        this.poll = setTimeout(() => void pump(), 40);
        return;
      }
      mediaTime = this.video.currentTime;
      capture = now;
      lastFrame = now;
      let bitmap: ImageBitmap | undefined;
      try {
        bitmap = await createImageBitmap(this.video);
        if (!this.active || this.worker !== worker) return;
        worker.postMessage({ type: "FRAME", bitmap, capture, generation }, [bitmap]);
        bitmap = undefined; // The worker now owns the frame.
      } catch {
        if (this.active) this.stop("error");
      } finally {
        bitmap?.close();
      }
    };
    const watchdog = () => {
      if (!this.active || this.worker !== worker) return;
      const now = performance.now();
      if (this.intent.tick(now).phase === "interrupted") return this.stop("suspended");
      if (now - lastFrame > (receivedFrame ? 750 : 3_000)) return this.stop("error");
      this.deadline = setTimeout(watchdog, 50);
    };
    worker.onmessage = ({ data }: MessageEvent<WorkerResult>) => {
      if (!this.active || this.worker !== worker || data.generation !== generation) return;
      if (data.type === "ERROR") return this.stop("error");
      if (!document.hasFocus() || document.visibilityState !== "visible") return this.stop("suspended");
      if (data.type === "READY") {
        if (this.ready) return;
        clearTimeout(this.deadline);
        this.ready = true;
        lastFrame = performance.now();
        this.publish(this.intent.setCamera("ready"));
        watchdog();
        void pump();
        return;
      }
      if (data.type !== "RESULT" || capture === null || capture !== data.capture) return this.stop("error");
      capture = null;
      receivedFrame = true;
      try {
        const observation = tracker.observe({
          captureMs: data.capture, width: data.width, height: data.height, hands: data.hands,
        });
        if (this.publish(this.intent.observe(observation, performance.now()))) return this.stop();
        this.poll = setTimeout(() => void pump(), 40);
      } catch {
        this.stop("error");
      }
    };
    worker.onerror = () => {
      if (this.active && this.worker === worker) this.stop("error");
    };
    worker.postMessage({ type: "INIT", generation });
  }
}
