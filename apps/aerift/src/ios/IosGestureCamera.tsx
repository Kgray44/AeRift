import { Channel, invoke } from "@tauri-apps/api/core";
import { createIosCameraPort, NativeGestureCamera, type GestureControlOptions, type NativeCameraEvent } from "@aerift/gestures";
import { GestureControl, type GestureCameraStatus, type TransferControls } from "@aerift/ui";
import type { MobilePlatform } from "./mobile-platform";

export type MobileCameraPermission = "notDetermined" | "authorized" | "denied" | "restricted" | "unavailable";

function createMobileCamera(platform: MobilePlatform) {
  async function permission(request = false): Promise<MobileCameraPermission> {
    try {
      return await invoke<MobileCameraPermission>(`plugin:aerift-${platform}|camera_permission`, { request });
    } catch {
      return "unavailable";
    }
  }

  // The two native plugins advertise the same event schema and lifecycle. Keep
  // separate bridge instances so gesture tokens and registrations never cross.
  const port = createIosCameraPort({
    authorized: async () => await permission() === "authorized",
    clockMs: () => invoke<number>(`plugin:aerift-${platform}|camera_clock`),
    createChannel: (listener) => new Channel<NativeCameraEvent>(listener),
    registerEvents: (events) => invoke<void>(`plugin:aerift-${platform}|register_camera_events`, { events }),
    start: (args) => invoke<void>(`plugin:aerift-${platform}|start_camera`, args),
    stop: (args) => invoke<void>(`plugin:aerift-${platform}|stop_camera`, args),
  });

  const createCamera: GestureControlOptions["createCamera"] = ({ id, intent, onFeedback }) =>
    new NativeGestureCamera(port, id, intent, onFeedback);
  return { permission, createCamera, isAuthorized: port.isAuthorized };
}

const cameras = {
  ios: createMobileCamera("ios"),
  android: createMobileCamera("android"),
};

export function mobileCameraPermission(platform: MobilePlatform, request = false) {
  return cameras[platform].permission(request);
}

export function MobileGestureCamera({ platform, controls, enabled, actionsBlocked, retryKey, onStatus }: {
  platform: MobilePlatform;
  controls: TransferControls;
  enabled: boolean;
  actionsBlocked: boolean;
  retryKey: number;
  onStatus: (status: GestureCameraStatus) => void;
}) {
  const camera = cameras[platform];
  return <GestureControl controls={controls} enabled={enabled} actionsBlocked={actionsBlocked} createCamera={camera.createCamera}
    mayReusePermission={camera.isAuthorized} onStatus={onStatus} retryKey={retryKey} />;
}
