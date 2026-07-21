import { describe, expect, it } from "vitest";
import {
  buildRotateCandidate,
  deriveRotateDurationMs,
  selectRotateCandidate,
  MAX_DERIVED_ROTATE_MS,
  MAX_ROTATE_BY_DEG,
  type RotateCandidate,
} from "../../src/tools/flows/flow-rotate-geometry";
import {
  systemEdgeGuards,
  SCREEN_EDGE_INSET,
  TARGET_START_FRACTION,
  type EdgeGuards,
} from "../../src/tools/flows/flow-pinch-geometry";
import { resolveDevice } from "../../src/utils/device-info";

const IOS_GUARDS = systemEdgeGuards(resolveDevice("00000000-0000-0000-0000-0000000000ab"));
const ANDROID_GUARDS = systemEdgeGuards(resolveDevice("emulator-5554"));

// Synthetic portrait phone: normalized X and Y are very different units.
const SCREEN_W = 1080;
const SCREEN_H = 2400;
const ASPECT = SCREEN_W / SCREEN_H;

/** Build both start-axis candidates and select, like runRotate does. */
function pick(
  center: { x: number; y: number },
  guards: EdgeGuards,
  frame?: { width: number; height: number },
  aspect = ASPECT
): RotateCandidate | undefined {
  const candidates = [
    buildRotateCandidate({ startAngle: 0, center, targetSpan: frame?.width, guards, aspect }),
    buildRotateCandidate({ startAngle: 90, center, targetSpan: frame?.height, guards, aspect }),
  ].filter((c): c is RotateCandidate => c !== undefined);
  return selectRotateCandidate(candidates);
}

describe("deriveRotateDurationMs", () => {
  it("follows ~90°/300ms with a floor of one 90° unit", () => {
    expect(deriveRotateDurationMs(90)).toBe(300);
    expect(deriveRotateDurationMs(720)).toBe(2400);
    expect(deriveRotateDurationMs(-720)).toBe(2400);
    expect(deriveRotateDurationMs(45)).toBe(300); // max(1, |by|/90) floor
  });

  it("stays linear up to the parse-bounded maximum sweep", () => {
    // No runtime cap: the parse bound on `by` keeps the derive inside the
    // single-gesture envelope by construction.
    expect(MAX_ROTATE_BY_DEG).toBe(3000);
    expect(deriveRotateDurationMs(MAX_ROTATE_BY_DEG)).toBe(MAX_DERIVED_ROTATE_MS);
    expect(deriveRotateDurationMs(-MAX_ROTATE_BY_DEG)).toBe(MAX_DERIVED_ROTATE_MS);
  });
});

describe("buildRotateCandidate / selectRotateCandidate", () => {
  it("produces a physically circular orbit: radiusX·W equals radiusY·H", () => {
    for (const frame of [undefined, { width: 0.8, height: 0.4 }, { width: 0.1, height: 0.6 }]) {
      const selected = pick({ x: 0.5, y: 0.5 }, IOS_GUARDS, frame)!;
      expect(selected.radiusX * SCREEN_W).toBeCloseTo(selected.radiusY * SCREEN_H, 9);
    }
  });

  it("keeps both initial points inside the target on the chosen axis", () => {
    const frame = { width: 0.3, height: 0.2 };
    const selected = pick({ x: 0.5, y: 0.5 }, IOS_GUARDS, frame)!;
    const separation =
      selected.startAngle === 0 ? 2 * selected.radiusX : 2 * selected.radiusY;
    const span = selected.startAngle === 0 ? frame.width : frame.height;
    expect(separation).toBeLessThanOrEqual(span * TARGET_START_FRACTION + 1e-9);
  });

  it("keeps every orbit point within the screen inset on both axes", () => {
    for (const center of [
      { x: 0.5, y: 0.5 },
      { x: 0.2, y: 0.8 },
      { x: 0.9, y: 0.1 },
    ]) {
      const selected = pick(center, IOS_GUARDS)!;
      for (let deg = 0; deg < 360; deg += 15) {
        const rad = (deg * Math.PI) / 180;
        const x = center.x + selected.radiusX * Math.cos(rad);
        const y = center.y + selected.radiusY * Math.sin(rad);
        expect(x).toBeGreaterThanOrEqual(SCREEN_EDGE_INSET - 1e-9);
        expect(x).toBeLessThanOrEqual(1 - SCREEN_EDGE_INSET + 1e-9);
        expect(y).toBeGreaterThanOrEqual(SCREEN_EDGE_INSET - 1e-9);
        expect(y).toBeLessThanOrEqual(1 - SCREEN_EDGE_INSET + 1e-9);
      }
    }
  });

  it("chooses the vertical start for a tall/narrow target (bigger physical orbit)", () => {
    const selected = pick({ x: 0.5, y: 0.5 }, IOS_GUARDS, { width: 0.1, height: 0.6 })!;
    expect(selected.startAngle).toBe(90);
  });

  it("starts vertical near a left edge and horizontal near the top", () => {
    // Left-edge target: horizontal Down points would sit in the back-swipe zone.
    const left = pick({ x: 0.06, y: 0.5 }, IOS_GUARDS, { width: 0.1, height: 0.2 })!;
    expect(left.startAngle).toBe(90);
    expect(left.axisSafe).toBe(true);
    expect(left.fullyEdgeSafe).toBe(false); // perpendicular coordinate stays in the guard

    // Top-edge target: vertical Down points would sit in the shade-pull zone.
    const top = pick({ x: 0.5, y: 0.06 }, IOS_GUARDS, { width: 0.2, height: 0.08 })!;
    expect(top.startAngle).toBe(0);
    expect(top.axisSafe).toBe(true);
    expect(top.fullyEdgeSafe).toBe(false);
  });

  it("guards the same near-side-edge target at 0.13 on android but 0.08 on ios", () => {
    // Wide, short target at x 0.2: horizontal Down points (0.11 / 0.29) clear
    // the iOS 0.08 side guard — and win on orbit size — but not Android's 0.13.
    const center = { x: 0.2, y: 0.5 };
    const frame = { width: 0.2, height: 0.04 };
    expect(pick(center, IOS_GUARDS, frame)!.startAngle).toBe(0);
    expect(pick(center, ANDROID_GUARDS, frame)!.startAngle).toBe(90);
  });

  it("tracks injected synthetic guards — the selection flips with the guard data alone", () => {
    const center = { x: 0.5, y: 0.5 };
    const sideGuarded: EdgeGuards = { left: 0.4, right: 0.4, top: 0, bottom: 0 };
    const capGuarded: EdgeGuards = { left: 0, right: 0, top: 0.4, bottom: 0.4 };
    expect(pick(center, sideGuarded)!.startAngle).toBe(90);
    expect(pick(center, capGuarded)!.startAngle).toBe(0);
  });

  it("still attempts a tiny target (no minimum size)", () => {
    const selected = pick({ x: 0.5, y: 0.5 }, IOS_GUARDS, { width: 0.01, height: 0.005 });
    expect(selected).toBeDefined();
    expect(selected!.radiusX).toBeGreaterThan(0);
    expect(selected!.radiusX * SCREEN_W).toBeCloseTo(selected!.radiusY * SCREEN_H, 9);
  });

  it("fails only when no positive on-screen radius exists", () => {
    expect(selectRotateCandidate([])).toBeUndefined();
    // A centroid inside the screen inset: every circle would cross it.
    expect(
      buildRotateCandidate({
        startAngle: 0,
        center: { x: 0.01, y: 0.5 },
        guards: IOS_GUARDS,
        aspect: ASPECT,
      })
    ).toBeUndefined();
    expect(
      buildRotateCandidate({
        startAngle: 90,
        center: { x: 0.01, y: 0.5 },
        guards: IOS_GUARDS,
        aspect: ASPECT,
      })
    ).toBeUndefined();
  });

  it("shares one radius bound across both candidates when there is no target", () => {
    const h = buildRotateCandidate({
      startAngle: 0,
      center: { x: 0.5, y: 0.5 },
      guards: IOS_GUARDS,
      aspect: ASPECT,
    })!;
    const v = buildRotateCandidate({
      startAngle: 90,
      center: { x: 0.5, y: 0.5 },
      guards: IOS_GUARDS,
      aspect: ASPECT,
    })!;
    // Same physical radius — only the Down placement differs.
    expect(h.radiusX).toBeCloseTo(v.radiusX, 12);
    expect(h.radiusY).toBeCloseTo(v.radiusY, 12);
  });

  it("prefers greater starting clearance, then larger orbit, among unsafe candidates", () => {
    const mk = (overrides: Partial<RotateCandidate>): RotateCandidate => ({
      startAngle: 0,
      radiusX: 0.2,
      radiusY: 0.09,
      axisSafe: false,
      fullyEdgeSafe: false,
      clearance: -0.05,
      ...overrides,
    });
    expect(
      selectRotateCandidate([mk({ clearance: -0.06 }), mk({ startAngle: 90, clearance: -0.01 })])!
        .startAngle
    ).toBe(90);
    expect(
      selectRotateCandidate([mk({ radiusX: 0.1 }), mk({ startAngle: 90, radiusX: 0.3 })])!
        .startAngle
    ).toBe(90);
  });
});
