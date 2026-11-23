import { WebGestureCamera, type GestureControlOptions } from "@aerift/gestures";
import { GestureControl, type GestureCameraStatus, type TransferControls } from "@aerift/ui";
import { useCallback } from "react";

export type CameraShortcut = "off" | "c" | "v";

export const cameraShortcutLabels: Record<CameraShortcut, string> = {
  off: "None",
  c: "Alt + Shift + C",
  v: "Alt + Shift + V",
};

async function mayReusePermission() {
  try {
    return (await navigator.permissions.query({ name: "camera" as PermissionName })).state === "granted";
  } catch {
    return false;
  }
}

export function GestureCamera({ controls, shortcut, enabled, actionsBlocked, source, retryKey, onStatus }: {
  controls: TransferControls;
  shortcut: CameraShortcut;
  enabled: boolean;
  actionsBlocked: boolean;
  source?: string;
  retryKey: number;
  onStatus: (status: GestureCameraStatus) => void;
}) {
  const createCamera = useCallback<GestureControlOptions["createCamera"]>(({ intent, video, onFeedback }) => {
    const camera = new WebGestureCamera(intent, video, onFeedback);
    return {
      start: () => camera.start({ workerUrl: new URL("/gesture-assets/hand-worker.js", location.origin), deviceId: source }),
      stop: () => camera.stop(),
      updateContext: target => camera.updateContext(target),
    };
  }, [source]);
  return <GestureControl controls={controls} enabled={enabled} actionsBlocked={actionsBlocked} showPreview requireWindowFocus
    shortcut={shortcut === "off" ? undefined : shortcut} createCamera={createCamera}
    mayReusePermission={mayReusePermission} onStatus={onStatus} retryKey={retryKey} cameraSource={source} />;
}
