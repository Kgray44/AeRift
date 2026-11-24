import { useCallback, useEffect, useRef } from "react";
import { snapshotFlights, visibleRefresh, type RefreshEnvironment } from "@aerift/app-contract/visible-refresh";

const browserEnvironment: RefreshEnvironment = {
  visible: () => document.visibilityState === "visible",
  now: () => performance.now(),
  later(fn, ms) {
    const timer = window.setTimeout(fn, ms);
    return () => window.clearTimeout(timer);
  },
  subscribe(fn) {
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
};

// Retain only active IPC, never cached data. A remount can share one in-flight
// snapshot for this exact command, without sharing any authority or destination.
const issue = snapshotFlights();

export function useVisibleNativeRefresh<T>(
  scope: string,
  period: number,
  read: () => Promise<T>,
  receive: (value: T) => void,
  stale: () => void,
  failure: () => void,
) {
  const details = useRef({ read, receive, stale, failure });
  details.current = { read, receive, stale, failure };
  const controller = useRef<Pick<ReturnType<typeof visibleRefresh>, "refresh"> | undefined>(undefined);
  useEffect(() => {
    const result = visibleRefresh(browserEnvironment, period,
      () => issue(scope, () => details.current.read()),
      ({ value, reused }) => {
        if (reused) controller.current?.refresh();
        else details.current.receive(value);
      },
      () => details.current.stale(), () => details.current.failure(),
    );
    controller.current = result;
    return () => { controller.current = undefined; result.close(); };
  }, [period, scope]);
  return useCallback(() => controller.current?.refresh(), []);
}
