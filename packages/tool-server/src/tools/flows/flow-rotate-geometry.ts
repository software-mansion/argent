import { SCREEN_EDGE_INSET, TARGET_START_FRACTION, type EdgeGuards } from "./flow-pinch-geometry";

/**
 * Pure geometry for the `rotate:` flow directive: duration and initial
 * placement for a fixed-centroid, constant-physical-radius orbit — drifting the
 * centroid would couple pan into the turn, growing the radius would couple
 * pinch, so the angular delta stays exact at the cost of a smaller orbit near
 * edges and small targets. No device access.
 */

/** Recognizer-friendly rotation pace: ~90° per 300 ms. */
export const ROTATE_MS_PER_90_DEG = 300;
/** Single-gesture time envelope; {@link MAX_ROTATE_BY_DEG} derives from it. */
export const MAX_DERIVED_ROTATE_MS = 10_000;
/** Largest sweep one gesture delivers at the fixed pace (3000°); parse rejects `by` beyond it. */
export const MAX_ROTATE_BY_DEG = (MAX_DERIVED_ROTATE_MS / ROTATE_MS_PER_90_DEG) * 90;

/**
 * Duration at ~90°/300ms, floored at one 90° unit; parse bounds `by` at
 * {@link MAX_ROTATE_BY_DEG}, so the linear derive is bounded by construction.
 */
export function deriveRotateDurationMs(by: number): number {
  return Math.round(ROTATE_MS_PER_90_DEG * Math.max(1, Math.abs(by) / 90));
}

/** One initial-placement proposal: fingers on the horizontal or vertical axis. */
export interface RotateCandidate {
  /** Start axis: 0 = fingers at centroid ± r along x, 90 = along y. */
  startAngle: 0 | 90;
  /** Orbit radius as a fraction of screen WIDTH. */
  radiusX: number;
  /** The same physical radius as a fraction of screen HEIGHT (radiusX·W = radiusY·H). */
  radiusY: number;
  /** Down points clear the guard on the start axis. */
  axisSafe: boolean;
  /** Down points clear the guards on BOTH axes (axis + fixed perpendicular). */
  fullyEdgeSafe: boolean;
  /** Smallest Down-point distance to any guard boundary (negative = inside a guard). */
  clearance: number;
}

export interface RotateCandidateInput {
  startAngle: 0 | 90;
  center: { x: number; y: number };
  /**
   * The target frame's dimension MATCHING the start axis (width for 0, height
   * for 90 — normalized X and Y are different units, so never the min of both).
   * Undefined without a selector (screen-centre default).
   */
  targetSpan?: number;
  guards: EdgeGuards;
  /**
   * Screen pixel aspect (width / height): converts the one physical radius
   * between its normalized-x and normalized-y spellings. 1 = dimensions
   * unknown, leaving an orbit circular in normalized space only (a physical
   * ellipse).
   */
  aspect: number;
}

/**
 * Build one start-axis candidate. The radius is the largest keeping the WHOLE
 * swept circle inside the screen inset on both axes — that bound depends only
 * on centroid and aspect, so both candidates share it — further capped, with a
 * selector, so both Down points land inside the target on the start axis
 * (ownership is decided at touch-down; the later orbit may leave the frame).
 * Guards never shrink the radius, they only score the start placement (see
 * {@link selectRotateCandidate}). Undefined when no positive radius fits.
 */
export function buildRotateCandidate(input: RotateCandidateInput): RotateCandidate | undefined {
  const { startAngle, center, targetSpan, guards, aspect } = input;

  // The circle spans centroid ± r on both axes whatever the start, so each
  // axis's clearance to the inset box caps the physical radius; a vertical
  // clearance divided by the aspect is that cap in fraction-of-width units.
  const xClear = Math.min(center.x - SCREEN_EDGE_INSET, 1 - SCREEN_EDGE_INSET - center.x);
  const yClear = Math.min(center.y - SCREEN_EDGE_INSET, 1 - SCREEN_EDGE_INSET - center.y);
  const screenRx = Math.min(xClear, yClear / aspect);

  // Down-point separation is 2r on the start axis; keep it inside the span.
  const targetRx =
    targetSpan === undefined
      ? Infinity
      : startAngle === 0
        ? (targetSpan * TARGET_START_FRACTION) / 2
        : (targetSpan * TARGET_START_FRACTION) / 2 / aspect;

  const radiusX = Math.min(screenRx, targetRx);
  if (!(radiusX > 0)) return undefined;
  const radiusY = radiusX * aspect;

  // Guard scoring as in pinch: the Down pair against the start axis's guard
  // pair, the fixed perpendicular coordinate against the other pair.
  const c = startAngle === 0 ? center.x : center.y;
  const half = startAngle === 0 ? radiusX : radiusY;
  const gLow = startAngle === 0 ? guards.left : guards.top;
  const gHigh = startAngle === 0 ? guards.right : guards.bottom;
  const p = startAngle === 0 ? center.y : center.x;
  const pLow = startAngle === 0 ? guards.top : guards.left;
  const pHigh = startAngle === 0 ? guards.bottom : guards.right;

  const downLow = c - half;
  const downHigh = c + half;
  const axisSafe = downLow >= gLow && downHigh <= 1 - gHigh;
  // Both Down points share the perpendicular coordinate, so one check covers them.
  const perpSafe = p >= pLow && p <= 1 - pHigh;
  const clearance = Math.min(downLow - gLow, 1 - gHigh - downHigh, p - pLow, 1 - pHigh - p);

  return {
    startAngle,
    radiusX,
    radiusY,
    axisSafe,
    fullyEdgeSafe: axisSafe && perpSafe,
    clearance,
  };
}

/**
 * Pick the start placement to dispatch — pinch's ranking with the radius as the
 * travel measure (arc length ∝ radius for a fixed angle):
 * 1. fully edge-safe, largest orbit;
 * 2. otherwise Down points on the axis parallel to the violated edge (axis-safe
 *    but perpendicular-violated) — vertical near a left/right edge, horizontal
 *    near a top/bottom one;
 * 3. then greater starting clearance, then larger orbit.
 * Undefined only for an empty list — a violated guard is demoted, never
 * rejected.
 */
export function selectRotateCandidate(candidates: RotateCandidate[]): RotateCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const rank = (c: RotateCandidate): number => (c.fullyEdgeSafe ? 0 : c.axisSafe ? 1 : 2);
  return [...candidates].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.fullyEdgeSafe && b.fullyEdgeSafe) return b.radiusX - a.radiusX;
    return b.clearance - a.clearance || b.radiusX - a.radiusX;
  })[0];
}
