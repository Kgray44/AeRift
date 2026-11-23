import { Channel, invoke } from "@tauri-apps/api/core";
import { createIosCameraPort, NativeGestureCamera, type GestureControlOptions, type NativeCameraEvent } from "@aerift/gestures";
import { GestureControl, type GestureCameraStatus, type TransferControls } from "@aerift/ui";

const cameraPort = createIosCameraPort({
  authorized: () => invoke<boolean>("plugin:aerift-ios|camera_authorized"),
  clockMs: () => invoke<number>("plugin:aerift-ios|camera_clock"),
  createChannel: (listener) => new Channel<NativeCameraEvent>(listener),
  registerEvents: (events) => invoke<void>("plugin:aerift-ios|register_camera_events", { events }),
  start: (args) => invoke<void>("plugin:aerift-ios|start_camera", args),
  stop: (args) => invoke<void>("plugin:aerift-ios|stop_camera", args),
});

const createCamera: GestureControlOptions["createCamera"] = ({ id, intent, onFeedback }) =>
  new NativeGestureCamera(cameraPort, id, intent, onFeedback);

export function IosGestureCamera({ controls, enabled, actionsBlocked, retryKey, onStatus }: {
  controls: TransferControls;
  enabled: boolean;
  actionsBlocked: boolean;
  retryKey: number;
  onStatus: (status: GestureCameraStatus) => void;
}) {
  return <GestureControl controls={controls} enabled={enabled} actionsBlocked={actionsBlocked} createCamera={createCamera}
    mayReusePermission={cameraPort.isAuthorized} onStatus={onStatus} retryKey={retryKey} />;
}
