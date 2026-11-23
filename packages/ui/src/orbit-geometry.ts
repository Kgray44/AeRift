export interface OrbitPoint { x: number; y: number }
export type OrbitArrow = "ArrowRight" | "ArrowDown" | "ArrowLeft" | "ArrowUp";

/** CSS-pixel distances from the trigger's center to the available viewport edges. */
export function orbitSlots(count: number, space: { right: number; bottom: number; diameter: number }): OrbitPoint[] | null {
  if (count === 0) return [];
  const start = 4 * Math.PI / 180;
  const end = 86 * Math.PI / 180;
  const step = count === 1 ? end - start : (end - start) / (count - 1);
  const half = space.diameter / 2;
  const gap = space.diameter + 19;
  const minimum = Math.max(gap, gap / (2 * Math.sin(step / 2)));
  const maximum = Math.min((space.right - half - 14) / Math.cos(start), (space.bottom - half - 34) / Math.sin(end));
  if (maximum < minimum) return null;

  const radius = Math.min(maximum, minimum + 31);
  return Array.from({ length: count }, (_, index) => {
    const angle = count === 1 ? (start + end) / 2 : start + step * index;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}

export function orbitNeighbor(count: number, index: number, direction: OrbitArrow) {
  const step = direction === "ArrowLeft" || direction === "ArrowDown" ? 1 : -1;
  return Math.max(0, Math.min(count - 1, index + step));
}
