import { Channel, invoke } from "@tauri-apps/api/core";
import { createIosCameraPort, mountSendGesture, NativeGestureCamera, type NativeCameraEvent } from "@aerift/gestures";
import type { TransferControls } from "@aerift/ui";
import { useEffect, useLayoutEffect, useRef } from "react";

const cameraPort = createIosCameraPort({
  clockMs: () => invoke<number>("plugin:aerift-ios|camera_clock"),
  createChannel: (listener) => new Channel<NativeCameraEvent>(listener),
  registerEvents: (events) => invoke<void>("plugin:aerift-ios|register_camera_events", { events }),
  start: (args) => invoke<void>("plugin:aerift-ios|start_camera", args),
  stop: (args) => invoke<void>("plugin:aerift-ios|stop_camera", args),
});

export function IosGestureCamera({ controls, enabled }: {
  controls: TransferControls;
  enabled: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const mounted = useRef<ReturnType<typeof mountSendGesture> | null>(null);
  const context = useRef({ controls, enabled });

  useLayoutEffect(() => {
    context.current = { controls, enabled };
    mounted.current?.update();
  }, [controls, enabled]);

  useEffect(() => {
    const container = element.current;
    if (!container) return;
    const gesture = mountSendGesture(container, {
      readControls() {
        const { controls, enabled } = context.current;
        return enabled ? controls : { ...controls, intent: null, busy: true };
      },
      createCamera({ id, intent, onFeedback }) {
        return new NativeGestureCamera(cameraPort, id, intent, onFeedback);
      },
    });
    const button = container.querySelector("button");
    button?.classList.add("ae-button");
    if (button) button.dataset.variant = "quiet";
    mounted.current = gesture;
    return () => {
      mounted.current = null;
      gesture.dispose();
    };
  }, []);

  return <div className="aerift-camera" ref={element} />;
}
