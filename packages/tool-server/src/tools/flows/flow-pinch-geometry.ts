import type { DeviceInfo } from "@argent/registry";

/**
 * Pure geometry for the `pinch:` flow directive: ratio decomposition, per-axis
 * candidate construction, and edge-aware candidate selection. Everything here
 * is deterministic data-in/data-out — no device access — so unit tests can
 * drive it with synthetic centers, spans, and {@link EdgeGuards}.
 */

/** Reliable separation ratio for ONE pinch gesture; larger scales are chained. */
export const PINCH_RATIO_PER_GESTURE = 4;
/** Delay between chained sub-gestures so the recognizer fully resets. */
export const PINCH_SETTLE_MS = 250;
/** Down-point fraction of the target span; 0.82 still fits a rotated square's hit area (chord ≥ ~0.828 of its AABB). */
export const TARGET_START_FRACTION = 0.82;
/** No touch point — Down included — lands inside this fraction of a screen edge. */
export const SCREEN_EDGE_INSET = 0.02;
/** Below roughly this separation change the platform pinch recognizers won't fire (a guaranteed no-op); demotes candidates in ranking only, never rejects a step. */
export const MIN_VIABLE_TRAVEL = 0.03;

/** Normalized no-start zones per screen edge (left/right as fractions of width, top/bottom of height). */
export interface EdgeGuards {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Prefer-not-reject no-start zones around the OS edge-swipe areas. Constants
 * for now (the real zones are fixed dp scaled by user settings, so these
 * over-guard tablets); this function is the single seam for a future
 * per-device query — geometry only ever receives the resulting EdgeGuards.
 */
export function systemEdgeGuards(device: DeviceInfo): EdgeGuards {
  // Android's side back-gesture zone reaches ~0.12 of width at the "Highest"
  // sensitivity (Pixel 8 measurement); every other zone sits under 0.08.
  return device.platform === "android"
    ? { left: 0.13, right: 0.13, top: 0.08, bottom: 0.08 }
    : { left: 0.08, right: 0.08, top: 0.08, bottom: 0.08 };
}

/**
 * Split a scale into `n` equal-ratio sub-gestures of at most
 * {@link PINCH_RATIO_PER_GESTURE} each. Depends only on the requested ratio —
 * never on target size — and grows logarithmically, so there is no gesture
 * count cap (`scale: 1e6` is 10 gestures).
 */
export function decomposePinch(scale: number): { n: number; per: number } {
  // |log scale| stays finite for subnormal scales, where 1/scale would overflow.
  // −1e-9: the log division can land epsilon-high on exact ratio powers
  // (log(4²⁹)/log(4) = 29.000000000000004), which would gain a spurious gesture.
  const n = Math.max(
    1,
    Math.ceil(Math.abs(Math.log(scale)) / Math.log(PINCH_RATIO_PER_GESTURE) - 1e-9)
  );
  return { n, per: scale ** (1 / n) };
}

/** One axis-aligned pinch proposal, scored for edge safety and travel. */
export interface PinchCandidate {
  /** Finger axis: 0 = horizontal, 90 = vertical. */
  angle: 0 | 90;
  /** Start finger separation (normalized along the axis). */
  start: number;
  /** End finger separation. */
  end: number;
  /** Along-axis centroid coordinate at gesture end (may drift from the start). */
  endCenter: number;
  /** Absolute separation change — the motion the recognizer sees. */
  travel: number;
  /** Travel clears {@link MIN_VIABLE_TRAVEL} — a sub-floor gesture is a recognizer no-op. */
  viable: boolean;
  /** Down points clear the guard on the gesture axis. */
  axisSafe: boolean;
  /** Down points clear the guards on BOTH axes (axis + fixed perpendicular). */
  fullyEdgeSafe: boolean;
  /** Smallest Down-point distance to any guard boundary (negative = inside a guard). */
  clearance: number;
}

export interface AxisCandidateInput {
  angle: 0 | 90;
  center: { x: number; y: number };
  /**
   * The target frame's dimension MATCHING the axis (width for 0, height for
   * 90 — normalized X and Y are different units, so never the min of both).
   * Undefined when the pinch has no selector (screen-center default).
   */
  targetSpan?: number;
  /** Per-sub-gesture ratio from {@link decomposePinch}. */
  per: number;
  guards: EdgeGuards;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Build one axis candidate: start span sized to the target (Down points must
 * land inside it so it claims the gesture — later moves may leave it), limited
 * by the system-edge guards, with the centroid drifting inward only as much as
 * needed to keep the final pointers inside the screen inset. Returns undefined
 * when the axis yields no positive on-screen motion.
 */
export function buildAxisCandidate(input: AxisCandidateInput): PinchCandidate | undefined {
  const { angle, center, targetSpan, per, guards } = input;
  // Along-axis guard pair and the fixed perpendicular coordinate's pair.
  const c = angle === 0 ? center.x : center.y;
  const gLow = angle === 0 ? guards.left : guards.top;
  const gHigh = angle === 0 ? guards.right : guards.bottom;
  const p = angle === 0 ? center.y : center.x;
  const pLow = angle === 0 ? guards.top : guards.left;
  const pHigh = angle === 0 ? guards.bottom : guards.right;

  const screenEndSpan = 1 - 2 * SCREEN_EDGE_INSET; // the centroid may move to use it
  const edgeSafeStartSpan = 2 * Math.max(0, Math.min(c - gLow, 1 - gHigh - c));
  // Centroid inside the guard: the fallback still clamps Down points to the
  // screen inset — the full screen span would start exactly where OS edge
  // swipes begin.
  const insetStartSpan =
    2 * Math.max(0, Math.min(c - SCREEN_EDGE_INSET, 1 - SCREEN_EDGE_INSET - c));
  const screenStartLimit =
    edgeSafeStartSpan > 0
      ? Math.min(screenEndSpan, edgeSafeStartSpan)
      : Math.min(screenEndSpan, insetStartSpan);
  const startLimit =
    targetSpan !== undefined
      ? Math.min(screenStartLimit, targetSpan * TARGET_START_FRACTION)
      : screenStartLimit;

  const start = per > 1 ? Math.min(startLimit, screenEndSpan / per) : startLimit;
  const end = Math.min(screenEndSpan, start * per);
  const travel = Math.abs(end - start);
  if (!(travel > 0)) return undefined;

  // Drift the centroid only as much as needed to fit both final pointers.
  const endCenter = clamp(c, SCREEN_EDGE_INSET + end / 2, 1 - SCREEN_EDGE_INSET - end / 2);

  const downLow = c - start / 2;
  const downHigh = c + start / 2;
  const axisSafe = downLow >= gLow && downHigh <= 1 - gHigh;
  // Both Down points share the perpendicular coordinate, so one check covers them.
  const perpSafe = p >= pLow && p <= 1 - pHigh;
  const clearance = Math.min(downLow - gLow, 1 - gHigh - downHigh, p - pLow, 1 - pHigh - p);

  return {
    angle,
    start,
    end,
    endCenter,
    travel,
    viable: travel >= MIN_VIABLE_TRAVEL,
    axisSafe,
    fullyEdgeSafe: axisSafe && perpSafe,
    clearance,
  };
}

/**
 * Pick the candidate to dispatch:
 * 1. viable candidates (travel ≥ {@link MIN_VIABLE_TRAVEL}) before sub-floor
 *    ones — an edge-risky but perceptible gesture beats a safe one the
 *    recognizer is guaranteed to ignore;
 * 2. the fully edge-safe candidate with the greatest separation travel;
 * 3. otherwise one whose motion runs parallel to the violated edge (axis-safe
 *    but perpendicular-violated) — OS edge swipes need motion away from the
 *    edge, so a parallel start is the least likely to be captured;
 * 4. then greater starting clearance, then greater travel.
 * Travel compares raw normalized units across axes (DeviceInfo carries no
 * viewport to equalize them) — an accepted marginal bias. When every candidate
 * is sub-floor the safety ranking still decides — the least-bad candidate is
 * dispatched. Undefined only when no candidate has positive motion — a
 * violated guard is accepted (attempted), never rejected.
 */
export function selectPinchCandidate(candidates: PinchCandidate[]): PinchCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const rank = (c: PinchCandidate): number => (c.fullyEdgeSafe ? 0 : c.axisSafe ? 1 : 2);
  return [...candidates].sort((a, b) => {
    const byViable = Number(b.viable) - Number(a.viable);
    if (byViable !== 0) return byViable;
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.fullyEdgeSafe && b.fullyEdgeSafe) return b.travel - a.travel;
    return b.clearance - a.clearance || b.travel - a.travel;
  })[0];
}
