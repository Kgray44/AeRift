import type { NativeCameraEvent, NativeCameraPort } from "./native-camera.js";

interface IosCameraTransport<Channel> {
  authorized?(): Promise<boolean>;
  clockMs(): Promise<number>;
  createChannel(listener: (event: NativeCameraEvent) => void): Channel;
  registerEvents(events: Channel): Promise<void>;
  start(args: { attemptId: string }): Promise<void>;
  stop(args: { attemptId: string }): Promise<void>;
}

/** Keep one camera event channel per WebView. Subscribe separately for each attempt. */
export function createIosCameraPort<Channel>(transport: IosCameraTransport<Channel>): NativeCameraPort & {
  isAuthorized(): Promise<boolean>;
} {
  let subscription: { attemptId: string | null; listener: (event: NativeCameraEvent) => void } | null = null;
  let registration: Promise<void> | undefined;
  let stopBarrier = Promise.resolve();
  return {
    async isAuthorized() {
      try {
        return await transport.authorized?.() === true;
      } catch {
        return false;
      }
    },
    async subscribe(listener) {
      if (subscription) throw new Error("Camera event listener is already active.");
      const current = { attemptId: null, listener };
      subscription = current;
      return () => {
        if (subscription === current) subscription = null;
      };
    },
    clockMs: () => transport.clockMs(),
    async start(attemptId) {
      const current = subscription;
      if (!current || current.attemptId !== null) throw new Error("Camera attempt requires a fresh subscription.");
      current.attemptId = attemptId;
      registration ??= Promise.resolve().then(() => transport.registerEvents(transport.createChannel((event) => {
        const active = subscription;
        if (active && event.attemptId === active.attemptId) active.listener(event);
      })));
      await registration;
      await stopBarrier;
      if (subscription === current && current.attemptId === attemptId) await transport.start({ attemptId });
    },
    stop: (attemptId) => {
      if (subscription?.attemptId === attemptId) subscription = null;
      // Retain the stop acknowledgement as a barrier for the next attempt.
      const stopped = transport.stop({ attemptId });
      stopBarrier = Promise.allSettled([stopBarrier, stopped]).then(() => {});
      return stopped;
    },
  };
}
