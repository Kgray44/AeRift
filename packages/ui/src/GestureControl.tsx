import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  automaticGestureTarget, bindTransferGesture, cameraRecovery, presentGesture,
  type GestureControlOptions, type GestureTransferSelection,
} from "@aerift/gestures";
import type { TransferControls } from "./TransferWorkspace";

type Presentation = ReturnType<typeof presentGesture>;
type GestureCamera = ReturnType<GestureControlOptions["createCamera"]>;
type Attempt = {
  target: GestureTransferSelection;
  currentTarget: NonNullable<ReturnType<typeof bindTransferGesture>>["currentTarget"];
  camera?: GestureCamera;
  presentation?: Presentation;
  reachedReady: boolean;
};

const inactive: Presentation = { state: "inactive", message: "Camera off." };
const canceled: Presentation = { state: "canceled", phase: "canceled", message: "Gesture canceled." };
type Recovery = "ready" | "resting" | "suspended" | "blocked";
const pauseMs = 850;

export type GestureCameraStatus = {
  state: "disabled" | "standby" | "starting" | "permission" | "listening" | "detected" |
    "held" | "paused" | "unavailable";
  label: string;
  detail: string;
};

const cameraOff: GestureCameraStatus = { state: "disabled", label: "Camera off", detail: "Gesture recognition is disabled." };

export function GestureCameraIndicator({ status }: { status?: GestureCameraStatus }) {
  if (!status || status.state === "disabled") return null;
  return <span className="ae-camera-indicator" data-state={status.state} title={status.detail}
    role="status" aria-label={status.label}>
    <span className="ae-camera-light" aria-hidden="true" />
    <span>{status.label}</span>
  </span>;
}

export interface GestureControlProps {
  controls: TransferControls;
  enabled: boolean;
  actionsBlocked?: boolean;
  createCamera: GestureControlOptions["createCamera"];
  shortcut?: "c" | "v";
  showPreview?: boolean;
  requireWindowFocus?: boolean;
  mayReusePermission?: () => Promise<boolean>;
  onStatus?: (status: GestureCameraStatus) => void;
  retryKey?: number;
  cameraSource?: string;
}

export function GestureControl({ controls, enabled, actionsBlocked = false, createCamera, shortcut, showPreview = false,
  requireWindowFocus = false, mayReusePermission, onStatus, retryKey = 0, cameraSource }: GestureControlProps) {
  const video = useRef<HTMLVideoElement>(null);
  const progress = useRef<HTMLProgressElement>(null);
  const active = useRef<Attempt | null>(null);
  const waiting = useRef<Attempt | null>(null);
  const permissionRequested = useRef(false);
  const permissionGranted = useRef(false);
  const previousReset = useRef({ enabled, retryKey, cameraSource });
  const [focused, setFocused] = useState(() => !requireWindowFocus || document.hasFocus());
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [paused, setPaused] = useState(false);
  const [recovery, setRecovery] = useState<Recovery>("ready");
  const [running, setRunning] = useState(false);
  const [display, setDisplay] = useState<Presentation>(inactive);
  const [receiveId, setReceiveId] = useState("");
  const allowed = enabled && controls.foreground && visible && !paused;
  const eligible = allowed && focused;
  const latest = useRef({ controls, eligible, allowed, receiveId, actionsBlocked });
  const target = automaticGestureTarget(controls.intent, controls.incoming, receiveId);
  const chooseOffer = enabled && (controls.incoming.length > 1 ||
    (!!controls.intent && controls.incoming.length > 0) || (!!receiveId && controls.incoming.length > 0));

  useEffect(() => {
    if (receiveId && controls.foreground && !controls.incoming.some(offer => offer.transferId === receiveId)) {
      setReceiveId("");
    }
  }, [controls.foreground, controls.incoming, receiveId]);

  function publish(attempt: Attempt, next: Presentation) {
    const previous = attempt.presentation;
    if (previous?.state === next.state && previous.message === next.message && previous.phase === next.phase) return;
    attempt.presentation = next;
    setDisplay(next);
    if (next.phase && next.phase !== previous?.phase) {
      latest.current.controls.reportGesture({ target: attempt.target, phase: next.phase });
    }
  }

  function stop(attempt: Attempt) {
    active.current = null;
    attempt.camera?.stop();
    setRunning(false);
  }

  function start() {
    const element = video.current;
    if (!target || !element || active.current || waiting.current || latest.current.actionsBlocked) return;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    const binding = bindTransferGesture(id, target, () => {
      const live = latest.current;
      if (!live.allowed || document.visibilityState !== "visible" ||
        (requireWindowFocus && active.current?.reachedReady && !document.hasFocus())) {
        return { ...live.controls, busy: true };
      }
      // A modal may change appearance while a gesture is held. Keep tracking and
      // suppress commands until the user can see the workspace again.
      return live.actionsBlocked ? { ...live.controls, send: async () => false, accept: async () => false } : live.controls;
    }, outcome => {
      // The recognizer dispatches before publishing release.
      queueMicrotask(() => {
        if (waiting.current !== attempt) return;
        waiting.current = null;
        if (outcome === "sent") publish(attempt, { state: "offered", message: "Gesture confirmed. Check the Rift for status." });
        else if (outcome === "accepted") publish(attempt, { state: "accepted", message: "Incoming transfer accepted." });
        else publish(attempt, {
          state: "failed", phase: "failed",
          message: latest.current.actionsBlocked ? "Close Control Center before confirming a gesture." :
            outcome === "unavailable" ? "The transfer is no longer available." :
            target.kind === "receive" ? "The offer could not be accepted." : "The file could not be offered.",
        });
        setRecovery("resting");
      });
    }, () => latest.current.receiveId);
    if (!binding) return;

    const attempt: Attempt = { target, currentTarget: binding.currentTarget, reachedReady: false };
    active.current = attempt;
    permissionRequested.current = true;
    setRunning(true);
    if (progress.current) progress.current.value = 0;
    publish(attempt, { state: "activating", message: "Starting the camera…" });

    function fail() {
      if (active.current !== attempt) return;
      stop(attempt);
      setRecovery("blocked");
      publish(attempt, { state: "failed", phase: "failed", message: "Camera recognition could not start." });
    }

    try {
      attempt.camera = createCamera({
        id, intent: binding.intent, video: element,
        onFeedback(feedback) {
          if (active.current !== attempt) return;
          if (feedback.camera === "ready") {
            attempt.reachedReady = true;
            permissionGranted.current = true;
          }
          if (progress.current && progress.current.value !== feedback.progress) progress.current.value = feedback.progress;
          if (feedback.phase === "released") {
            waiting.current = attempt;
            stop(attempt);
          } else if (feedback.phase === "interrupted") {
            stop(attempt);
            const action = cameraRecovery(feedback, attempt.reachedReady || permissionGranted.current, !!mayReusePermission);
            setRecovery(action === "rearm" ? "resting" : action === "wait-for-foreground" ? "suspended" : "blocked");
            if (action === "rearm" && feedback.interruption === "attempt-timeout" && attempt.presentation?.state === "listening") {
              setDisplay(inactive);
              return;
            }
          }
          publish(attempt, presentGesture(feedback, target.kind));
        },
      });
      void attempt.camera.start().catch(fail);
    } catch {
      fail();
    }
  }

  const startLatest = useRef(start);
  useLayoutEffect(() => {
    latest.current = { controls, eligible, allowed, receiveId, actionsBlocked };
    startLatest.current = start;
    const previous = previousReset.current;
    const reset = enabled !== previous.enabled || retryKey !== previous.retryKey || cameraSource !== previous.cameraSource;
    previousReset.current = { enabled, retryKey, cameraSource };
    if (reset) {
      permissionRequested.current = false;
      setPaused(false);
      setRecovery("ready");
      setDisplay(inactive);
    }
    const attempt = active.current;
    if (!attempt) return;
    // The OS permission prompt may blur the window before a camera is available.
    if (reset || !enabled || !controls.foreground || !visible || paused || (!focused && attempt.reachedReady)) {
      stop(attempt);
      publish(attempt, canceled);
    } else {
      attempt.camera?.updateContext(attempt.currentTarget());
    }
  });

  useEffect(() => {
    const resume = () => {
      setVisible(document.visibilityState === "visible");
      setFocused(!requireWindowFocus || document.hasFocus());
      if (document.visibilityState === "visible") setRecovery(current => current === "suspended" ? "ready" : current);
    };
    const hide = () => setVisible(false);
    const blur = () => { if (requireWindowFocus) setFocused(false); };
    document.addEventListener("visibilitychange", resume);
    document.addEventListener("freeze", hide);
    document.addEventListener("resume", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("pagehide", hide);
    window.addEventListener("focus", resume);
    window.addEventListener("blur", blur);
    screen.orientation?.addEventListener?.("change", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      document.removeEventListener("freeze", hide);
      document.removeEventListener("resume", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("focus", resume);
      window.removeEventListener("blur", blur);
      screen.orientation?.removeEventListener?.("change", resume);
    };
  }, [requireWindowFocus]);

  useEffect(() => {
    if (!shortcut || !enabled || !controls.foreground) return;
    const code = "Key" + shortcut.toUpperCase();
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat || !event.altKey || !event.shiftKey ||
        event.ctrlKey || event.metaKey || event.code !== code) return;
      if (event.target instanceof HTMLElement &&
        (event.target.isContentEditable || event.target.closest("input, select, textarea"))) return;
      event.preventDefault();
      setPaused(previous => !previous);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut, enabled, controls.foreground]);

  useEffect(() => {
    if (recovery !== "resting") return;
    const timer = window.setTimeout(() => {
      setDisplay(inactive);
      setRecovery("ready");
    }, pauseMs);
    return () => window.clearTimeout(timer);
  }, [recovery]);

  const targetKey = target && (target.kind === "send" ? "send:" + target.selectionId : "receive:" + target.transferId);
  useEffect(() => {
    if (!eligible || actionsBlocked || !targetKey || controls.busy || running || recovery !== "ready" || waiting.current) return;
    if (!permissionRequested.current) {
      startLatest.current();
      return;
    }
    // A previous attempt may have consumed a prompt. Never open another prompt automatically.
    if (!permissionGranted.current && !mayReusePermission) {
      setDisplay({ state: "permission", message: "Camera access could not be verified. Retry in Control Center." });
      setRecovery("blocked");
      return;
    }
    if (!mayReusePermission) {
      startLatest.current();
      return;
    }
    let disposed = false;
    void mayReusePermission().then(granted => {
      if (disposed || !latest.current.eligible) return;
      if (granted) startLatest.current();
      else {
        setDisplay({ state: "permission", message: "Camera access must be renewed in Control Center." });
        setRecovery("blocked");
      }
    });
    return () => { disposed = true; };
  }, [eligible, actionsBlocked, targetKey, target?.deviceId, controls.busy, running, recovery, mayReusePermission, retryKey, cameraSource]);

  useLayoutEffect(() => () => {
    const attempt = active.current;
    active.current = null;
    waiting.current = null;
    attempt?.camera?.stop();
    if (attempt) latest.current.controls.reportGesture({ target: attempt.target, phase: "canceled" });
  }, []);

  const detecting = running && (display.state === "hand-detected" || display.state === "ready-to-grasp" || display.state === "grasping");
  const held = running && display.state === "held";
  const listening = running && (detecting || held || display.state === "listening");
  const offscreen = !controls.foreground || !visible || !focused;
  const justFinished = display.state === "offered" || display.state === "accepted" || display.phase !== undefined;
  const guide = detecting || held || (enabled && (display.state === "released" || (recovery === "resting" && justFinished)));
  const offer = (active.current?.target.kind === "receive") ? controls.incoming.find(
    item => active.current?.target.kind === "receive" && active.current.target.transferId === item.transferId) : undefined;

  const status: GestureCameraStatus = !enabled ? cameraOff :
    paused || (!running && (offscreen || recovery === "suspended"))
      ? { state: "paused", label: "Camera paused", detail: paused ? "Gesture recognition is paused for this session." : "Camera runs in the foreground workspace only." } :
    held ? { state: "held", label: "Camera on · Held", detail: display.message } :
    detecting ? { state: "detected", label: "Camera on · Hand detected", detail: display.message } :
    listening ? { state: "listening", label: "Camera on · Listening", detail: display.message } :
    display.state === "permission" || display.state === "permission-denied"
      ? { state: "permission", label: "Camera permission", detail: display.message } :
    running ? { state: "starting", label: "Camera starting", detail: display.message } :
    recovery === "blocked"
      ? { state: "unavailable", label: "Camera unavailable", detail: display.message } :
    { state: "standby", label: "Camera standby", detail: controls.busy ? "Gesture recognition waits for the current action." :
      target ? "Camera will listen when the gesture attempt is ready." : "Select a file and recipient or wait for an incoming offer." };

  const statusReporter = useRef(onStatus);
  statusReporter.current = onStatus;
  useEffect(() => {
    statusReporter.current?.({ state: status.state, label: status.label, detail: status.detail });
  }, [status.state, status.label, status.detail]);

  return <div className="ae-gesture-control" data-state={display.state} hidden={!guide && !chooseOffer}>
    {chooseOffer && <label className="ae-gesture-choice">Gesture target
      <select className="ae-gesture-offers" value={receiveId} disabled={held || detecting || display.state === "released"}
        onChange={event => {
          const attempt = active.current;
          if (attempt) {
            stop(attempt);
            publish(attempt, canceled);
          }
          setReceiveId(event.target.value);
        }}>
        <option value="">{controls.intent ? "Send selected file" : "Choose an incoming offer"}</option>
        {controls.incoming.map(candidate => <option key={candidate.transferId} value={candidate.transferId}>
          {candidate.label ?? "Incoming offer"}
        </option>)}
      </select>
    </label>}
    <div className="ae-gesture-guide" hidden={!guide}>
      <p className="ae-gesture-status" role="status" aria-atomic="true">
        {offer?.label && <strong>{offer.label} </strong>}{display.message}
      </p>
      <progress className="ae-gesture-progress" ref={progress} max={1} aria-label="Gesture hold progress"
        hidden={!detecting && !held} />
    </div>
    <video className="ae-gesture-preview" ref={video} aria-label="Local gesture camera preview"
      hidden={!showPreview || !detecting && !held} muted playsInline />
  </div>;
}
