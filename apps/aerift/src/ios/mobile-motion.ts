export type MobileMotionDirection = "back" | "forward";

/** Dock and module positions, not a synthetic history, determine entry direction. */
export function mobileMotionDirection<T>(
  order: readonly T[], previous: T | undefined, next: T | undefined,
): MobileMotionDirection | undefined {
  if (previous === undefined || next === undefined || previous === next) return undefined;
  const from = order.indexOf(previous);
  const to = order.indexOf(next);
  if (from < 0 || to < 0) return undefined;
  return from < to ? "forward" : "back";
}


/** Clear an in-flight decoration when motion becomes suppressed. */
export function observeMobileMotionSuppression(explicit: boolean, clear: () => void) {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const settle = () => { if (explicit || preference.matches || document.hidden) clear(); };
  settle();
  preference.addEventListener("change", settle);
  document.addEventListener("visibilitychange", settle);
  return () => {
    preference.removeEventListener("change", settle);
    document.removeEventListener("visibilitychange", settle);
  };
}
