// Adapted from VoyageWright Crossdeck and Watchglass. See ../README.md for provenance.
export type Posture = "open" | "fist" | "neutral" | "unusable";

export interface Landmark {
  x: number;
  y: number;
  z: number;
  /** Optional provider-reported joint confidence. MediaPipe Web does not report it. */
  confidence?: number;
}

export interface LandmarkFrame {
  captureMs: number;
  width: number;
  height: number;
  hands: readonly (readonly Landmark[])[];
}

export interface GestureObservation {
  captureMs: number;
  track: number | null;
  posture: Posture;
  confidence: number | null;
}

export const MAX_FRAME_GAP_MS = 220;

function posture(points: readonly Landmark[], aspect: number): Posture {
  const distance = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, (a.y - b.y) / aspect, a.z - b.z);
  const palm = Math.max(distance(points[5]!, points[17]!), 0.8 * distance(points[0]!, points[9]!));
  if (palm < 0.035 || palm > 0.65) return "neutral";
  const fingers = [5, 9, 13, 17].map((base) => {
    const a = points[base]!;
    const b = points[base + 1]!;
    const c = points[base + 2]!;
    const tip = points[base + 3]!;
    const length = distance(a, b) + distance(b, c) + distance(c, tip);
    return { extension: length > palm * 0.35 ? distance(a, tip) / length : -1, reach: distance(a, tip) / palm };
  });
  const extended = fingers.filter(({ extension, reach }) => extension >= 0.83 && reach >= 0.48).length;
  const curled = fingers.filter(({ extension, reach }) => extension >= 0 && extension <= 0.72 && reach <= 0.72).length;
  if (extended >= 3 && curled === 0 && distance(points[4]!, points[8]!) >= palm * 0.48) return "open";
  if (curled >= 3 && extended === 0) return "fist";
  return "neutral";
}


/** Local palm continuity. Each new capture session must create a new tracker. */
export class HandLandmarkTracker {
  private sequence = 0;
  private prior: { at: number; width: number; height: number; x: number; y: number; scale: number } | null = null;

  observe(frame: LandmarkFrame): GestureObservation {
    const { captureMs, width, height, hands } = frame;
    const rejected: GestureObservation = { captureMs, track: null, posture: "unusable", confidence: null };
    const points = hands.length === 1 ? hands[0] : undefined;
    if (!Number.isFinite(captureMs) || !Number.isFinite(width) || !Number.isFinite(height) ||
        width <= 0 || height <= 0 || points?.length !== 21 ||
        Array.from(points).some((p) => !p || ![p.x, p.y, p.z].every(Number.isFinite) ||
          p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) {
      this.prior = null;
      return rejected;
    }
    const scores = points.flatMap((p) => p.confidence === undefined ? [] : [p.confidence]);
    const confidence = scores.length ? Math.min(...scores) : null;
    if (confidence !== null && (!scores.every((score) => Number.isFinite(score) && score >= 0 && score <= 1) ||
        confidence < 0.6)) {
      this.prior = null;
      return rejected;
    }
    const palm = [points[0]!, points[5]!, points[9]!, points[17]!];
    const aspect = width / height;
    const center = palm.reduce((sum, p) => ({ x: sum.x + p.x / 4, y: sum.y + p.y / 4 }), { x: 0, y: 0 });
    const scale = Math.hypot(palm[1]!.x - palm[3]!.x, (palm[1]!.y - palm[3]!.y) / aspect);
    const prior = this.prior;
    if (!prior || prior.width !== width || prior.height !== height ||
        captureMs <= prior.at || captureMs - prior.at > MAX_FRAME_GAP_MS ||
        Math.hypot(center.x - prior.x, (center.y - prior.y) / aspect) + 0.25 * Math.abs(scale - prior.scale) > 0.14) {
      this.sequence++;
    }
    this.prior = { at: captureMs, width, height, ...center, scale };
    return { captureMs, track: this.sequence, posture: posture(points, aspect), confidence };
  }
}
