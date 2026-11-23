import { bindSendGesture, type SendGestureControls } from "./send-binding.js";
import type { GestureFeedback, GestureIntent, GestureTarget } from "./intent.js";

interface GestureCamera {
  start(): Promise<void>;
  stop(): void;
  updateContext(target: GestureTarget | null): void;
}

export interface GestureControlOptions {
  readControls(): SendGestureControls;
  showPreview?: boolean;
  createCamera(attempt: {
    id: string;
    intent: GestureIntent;
    video: HTMLVideoElement;
    onFeedback(feedback: GestureFeedback): void;
  }): GestureCamera;
}

interface Attempt {
  camera?: GestureCamera;
  currentTarget(): GestureTarget | null;
  outcomeKnown: boolean;
}

/** Mount in the transfer workspace's gesture slot. Keep its controls getter current. */
export function mountSendGesture(container: HTMLElement, options: GestureControlOptions) {
  const page = container.ownerDocument;
  const group = page.createElement("div");
  group.className = "ae-gesture-control";
  const button = page.createElement("button");
  button.type = "button";
  const status = page.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Camera is off.";
  const progress = page.createElement("progress");
  progress.max = 1;
  progress.setAttribute("aria-label", "Gesture hold progress");
  progress.hidden = true;
  const video = page.createElement("video");
  video.setAttribute("aria-label", "Gesture camera preview");
  video.hidden = true;
  video.width = 240;
  group.append(button, status, progress, video);
  container.append(group);

  let active: Attempt | null = null;
  let latestId: string | null = null;
  let waitingForSend = false;
  let disposed = false;

  function renderButton() {
    const controls = options.readControls();
    button.textContent = active ? "Cancel gesture" : "Use camera gesture";
    button.disabled = !active && (waitingForSend || !controls.intent || controls.busy);
  }

  function stopActive() {
    const attempt = active;
    active = null;
    progress.hidden = true;
    video.hidden = true;
    attempt?.camera?.stop();
    if (!disposed) renderButton();
  }

  function update() {
    if (disposed) return;
    active?.camera?.updateContext(active.currentTarget());
    renderButton();
  }

  async function activate() {
    if (disposed) return;
    if (active) {
      stopActive();
      status.textContent = "Gesture cancelled.";
      return;
    }
    if (waitingForSend) return;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const binding = bindSendGesture(id, options.readControls, (outcome) => {
      if (disposed || latestId !== id) return;
      attempt.outcomeKnown = true;
      waitingForSend = false;
      status.textContent = outcome === "sent" ? "Transfer offered." :
        outcome === "unavailable" ? "The selected file or device is unavailable." :
        "The transfer could not be offered. You can try again.";
      renderButton();
    });
    if (!binding) return;

    const attempt: Attempt = { currentTarget: binding.currentTarget, outcomeKnown: false };
    active = attempt;
    latestId = id;
    renderButton();
    try {
      attempt.camera = options.createCamera({
        id, intent: binding.intent, video,
        onFeedback(feedback) {
          if (active !== attempt) return;
          if (feedback.phase === "released") {
            waitingForSend = !attempt.outcomeKnown;
            if (waitingForSend) status.textContent = "Submitting transfer…";
            stopActive();
            return;
          }
          if (status.textContent !== feedback.message) status.textContent = feedback.message;
          if (feedback.phase === "interrupted") {
            stopActive();
            return;
          }
          progress.value = feedback.progress;
          progress.hidden = feedback.camera !== "ready";
          video.hidden = !options.showPreview || feedback.camera !== "ready";
        },
      });
      await attempt.camera.start();
    } catch {
      if (active !== attempt) return;
      stopActive();
      status.textContent = "Camera recognition could not start. You can still use Send.";
    }
  }

  const click = () => { void activate(); };
  button.addEventListener("click", click);
  renderButton();
  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      latestId = null;
      button.removeEventListener("click", click);
      stopActive();
      group.remove();
    },
  };
}
