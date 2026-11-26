/** Trusted, build-time visual tuning only. This type carries no app authority. */
type Spring = Readonly<{ stiffness: number; damping: number; mass: number }>;

export interface MotionPresentationProvider {
  readonly version: 1;
  readonly workspaceCard: Readonly<{
    settle: Spring;
    push: Spring;
    symbol: Readonly<{ hoverScale: number; hoverY: number; pressScale: number }>;
    chevron: Readonly<{ hoverX: number; pressX: number }>;
  }>;
}

export const PUBLIC_MOTION_PRESENTATION: MotionPresentationProvider = Object.freeze({
  version: 1,
  workspaceCard: Object.freeze({
    settle: Object.freeze({ stiffness: 490, damping: 32, mass: 0.56 }),
    push: Object.freeze({ stiffness: 670, damping: 42, mass: 0.44 }),
    symbol: Object.freeze({ hoverScale: 1.045, hoverY: -2, pressScale: 0.96 }),
    chevron: Object.freeze({ hoverX: 3, pressX: 1 }),
  }),
});

function data<const K extends string>(value: unknown, keys: readonly K[]): Record<K, unknown> | undefined {
  if (!value || typeof value !== "object" ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return;
  if (Reflect.ownKeys(value).length !== keys.length) return;
  const copy = {} as Record<K, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return;
    copy[key] = descriptor.value;
  }
  return copy;
}

function bounded(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function spring(value: unknown): Spring | undefined {
  const v = data(value, ["stiffness", "damping", "mass"]);
  if (!v || !bounded(v.stiffness, 100, 1000) || !bounded(v.damping, 15, 100)
      || !bounded(v.mass, 0.3, 1.5)) return;
  return { stiffness: v.stiffness, damping: v.damping, mass: v.mass };
}

/** Copies accepted scalars. It is a schema check, never a sandbox for executable code. */
export function validateMotionPresentation(input: unknown): MotionPresentationProvider | undefined {
  const root = data(input, ["version", "workspaceCard"]);
  if (!root || root.version !== 1) return;
  const card = data(root.workspaceCard, ["settle", "push", "symbol", "chevron"]);
  if (!card) return;
  const settle = spring(card.settle);
  const push = spring(card.push);
  const symbol = data(card.symbol, ["hoverScale", "hoverY", "pressScale"]);
  const chevron = data(card.chevron, ["hoverX", "pressX"]);
  if (!settle || !push || !symbol || !chevron ||
      !bounded(symbol.hoverScale, 0.86, 1.14) || !bounded(symbol.hoverY, -6, 6) ||
      !bounded(symbol.pressScale, 0.86, 1.14) ||
      !bounded(chevron.hoverX, -8, 8) || !bounded(chevron.pressX, -8, 8)) return;
  return {
    version: 1,
    workspaceCard: { settle, push,
      symbol: { hoverScale: symbol.hoverScale, hoverY: symbol.hoverY, pressScale: symbol.pressScale },
      chevron: { hoverX: chevron.hoverX, pressX: chevron.pressX },
    },
  };
}
