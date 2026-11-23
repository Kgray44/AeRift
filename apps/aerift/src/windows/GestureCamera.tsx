import { mountSendGesture, WebGestureCamera } from "@aerift/gestures";
import type { TransferControls } from "@aerift/ui";
import { useEffect, useLayoutEffect, useRef } from "react";

export type CameraShortcut = "off" | "c" | "v";

export const cameraShortcutLabels: Record<CameraShortcut, string> = {
  off: "None",
  c: "Alt + Shift + C",
  v: "Alt + Shift + V",
};

export function GestureCamera({ controls, shortcut, enabled }: {
  controls: TransferControls;
  shortcut: CameraShortcut;
  enabled: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const control = useRef<ReturnType<typeof mountSendGesture> | null>(null);
  const current = useRef({ controls, enabled });

  useLayoutEffect(() => {
    current.current = { controls, enabled };
    control.current?.update();
  }, [controls, enabled]);

  useEffect(() => {
    if (!container.current) return;
    const instance = mountSendGesture(container.current, {
      readControls() {
        const { controls, enabled } = current.current;
        return enabled ? controls : { ...controls, intent: null, busy: true };
      },
      showPreview: true,
      createCamera({ intent, video, onFeedback }) {
        const camera = new WebGestureCamera(intent, video, onFeedback);
        return {
          start: () => camera.start({ workerUrl: new URL("/gesture-assets/hand-worker.js", location.origin) }),
          stop: () => camera.stop(),
          updateContext: (target) => camera.updateContext(target),
        };
      },
    });
    const button = container.current.querySelector("button");
    button?.classList.add("ae-button");
    if (button) button.dataset.variant = "secondary";
    control.current = instance;
    return () => {
      control.current = null;
      instance.dispose();
    };
  }, []);

  useEffect(() => {
    if (shortcut === "off") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat ||
        !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey ||
        event.code !== `Key${shortcut.toUpperCase()}`) return;
      if (event.target instanceof HTMLElement &&
        (event.target.isContentEditable || event.target.closest("input, select, textarea"))) return;
      const button = container.current?.querySelector("button");
      if (!button || button.disabled) return;
      event.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);

  return <div className="aerift-camera" ref={container} />;
}
