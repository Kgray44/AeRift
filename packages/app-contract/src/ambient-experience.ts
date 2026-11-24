/** Trusted-host to renderer projection; never a gesture command or a transfer protocol. */
const phases = ["hand", "context", "picked-up", "held", "ambiguous", "destination-ready",
  "released", "offering", "awaiting-acceptance", "transferring", "receiving",
  "arriving", "completed", "cancelled", "expired", "rejected", "disconnected", "interrupted", "failed"] as const;
export type AmbientPhase = (typeof phases)[number];
export interface AmbientChoreographyFrame {
  version: 1;
  /** Opaque host-generated, per-attempt epoch. Subscription owns epoch replacement. */
  interaction: string;
  sequence: number;
  phase: AmbientPhase;
  progress?: number;
  /** Non-sensitive display count only; no title, payload, path, camera or app identifier. */
  count?: number;
  /** Host attaches this only after its transport or Inbox verifies a committed receipt. */
  verified?: true;
}
export const isAmbientTerminal = (phase: AmbientPhase) =>
  ["completed", "cancelled", "expired", "rejected", "disconnected", "interrupted", "failed"].includes(phase);
const rank: Record<AmbientPhase, number> = {
  hand: 0, context: 1, "picked-up": 2, held: 3, ambiguous: 3, "destination-ready": 4,
  released: 5, offering: 6, "awaiting-acceptance": 7, transferring: 8, receiving: 8,
  arriving: 9, completed: 10, cancelled: 10, expired: 10, rejected: 10,
  disconnected: 10, interrupted: 10, failed: 10,
};
export function advanceAmbientChoreography(
  current: AmbientChoreographyFrame | undefined, incoming: unknown,
): AmbientChoreographyFrame | undefined {
  if (typeof incoming !== "object" || incoming === null) return current;
  const raw = incoming as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.interaction !== "string" ||
      !/^[a-f\d-]{8,64}$/.test(raw.interaction) ||
      typeof raw.sequence !== "number" || !Number.isSafeInteger(raw.sequence) || raw.sequence < 0 ||
      typeof raw.phase !== "string" || !phases.includes(raw.phase as AmbientPhase)) return current;
  const phase = raw.phase as AmbientPhase;
  if (phase === "completed" && raw.verified !== true) return current;
  const count = raw.count;
  if (count !== undefined && (typeof count !== "number" || !Number.isSafeInteger(count) ||
    count < 1 || count > 4096)) return current;
  const progress = raw.progress;
  if (progress !== undefined && (typeof progress !== "number" ||
      !Number.isFinite(progress) || progress < 0 || progress > 1 ||
      (phase !== "transferring" && phase !== "receiving"))) return current;
  if (current && (isAmbientTerminal(current.phase) || raw.interaction !== current.interaction ||
      raw.sequence <= current.sequence || rank[phase] < rank[current.phase] ||
      phase !== current.phase && rank[phase] === rank[current.phase] && rank[phase] !== rank.held ||
      count !== undefined && current.count !== undefined && count !== current.count ||
      progress !== undefined && progress < (current.progress ?? 0) ||
      progress === undefined && phase === current.phase && current.progress !== undefined)) return current;
  return {
    version: 1, interaction: raw.interaction, sequence: raw.sequence, phase,
    ...(progress === undefined ? {} : { progress }),
    ...((count ?? current?.count) === undefined ? {} : { count: count ?? current?.count as number }),
    ...(phase === "completed" ? { verified: true } : {}),
  };
}
