export const DOCK_SETTLE_LIMIT_MS = 520;
export const dockSpring = { stiffness: 620, damping: 48, mass: 0.8, restSpeed: 0.05, restDelta: 0.002 } as const;
export function dockPointerPosition(clientX: number, left: number, width: number, count: number, rtl: boolean) {
  if (width <= 0 || count < 1) return 0;
  const physical = clientX - left;
  return Math.min(count - 1, Math.max(0, (rtl ? width - physical : physical) / width * count - 0.5));
}
export function dockSquash(tabsPerSecond: number) {
  return Math.min(0.14, Math.abs(tabsPerSecond) * 0.009);
}
export function isDockScrub(dx: number, dy: number) {
  return Math.abs(dx) >= 8 && Math.abs(dx) > Math.abs(dy) * 1.4;
}
