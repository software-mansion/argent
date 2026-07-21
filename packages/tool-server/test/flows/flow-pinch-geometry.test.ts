import { describe, expect, it } from "vitest";
import {
  buildAxisCandidate,
  decomposePinch,
  selectPinchCandidate,
  systemEdgeGuards,
  PINCH_RATIO_PER_GESTURE,
  SCREEN_EDGE_INSET,
  type EdgeGuards,
  type PinchCandidate,
} from "../../src/tools/flows/flow-pinch-geometry";
import { resolveDevice } from "../../src/utils/device-info";

const IOS_GUARDS = systemEdgeGuards(resolveDevice("00000000-0000-0000-0000-0000000000ab"));
const ANDROID_GUARDS = systemEdgeGuards(resolveDevice("emulator-5554"));

/** Build both axis candidates and select, like runPinch does. */
function pick(
  center: { x: number; y: number },
  per: number,
  guards: EdgeGuards,
  frame?: { width: number; height: number }
): PinchCandidate | undefined {
  const candidates = [
    buildAxisCandidate({ angle: 0, center, targetSpan: frame?.width, per, guards }),
    buildAxisCandidate({ angle: 90, center, targetSpan: frame?.height, per, guards }),
  ].filter((c): c is PinchCandidate => c !== undefined);
  return selectPinchCandidate(candidates);
}

describe("decomposePinch", () => {
  it("splits by the per-gesture ratio cap only, with equal-ratio sub-gestures", () => {
    expect(decomposePinch(2)).toEqual({ n: 1, per: 2 });
    expect(decomposePinch(0.5)).toEqual({ n: 1, per: 0.5 });

    const zoomIn = decomposePinch(20);
    expect(zoomIn.n).toBe(3);
    expect(zoomIn.per).toBeCloseTo(20 ** (1 / 3), 12);

    const zoomOut = decomposePinch(0.05);
    expect(zoomOut.n).toBe(3);
    expect(zoomOut.per).toBeCloseTo(0.05 ** (1 / 3), 12);
  });

  it("grows logarithmically with no gesture-count cap (scale 1e6 → 10 gestures)", () => {
    expect(decomposePinch(1e6).n).toBe(10);
  });

  it("decomposes extreme scales finitely — a subnormal scale must not overflow via 1/scale", () => {
    // 5e-324 (Number.MIN_VALUE) is exactly 4^-537: the reciprocal is Infinity,
    // but the log-space magnitude still decomposes it.
    const tiny = decomposePinch(5e-324);
    expect(tiny.n).toBe(537);
    expect(Number.isFinite(tiny.per)).toBe(true);
    expect(tiny.per).toBeGreaterThan(0);
    expect(tiny.per).toBeLessThan(1);
    expect(tiny.per ** tiny.n).toBe(5e-324);

    const huge = decomposePinch(1e300);
    expect(huge.n).toBe(499);
    expect(huge.per).toBeCloseTo(1e300 ** (1 / 499), 12);
  });

  it("does not gain a spurious gesture on exact ratio powers", () => {
    expect(decomposePinch(4).n).toBe(1);
    expect(decomposePinch(16).n).toBe(2);
    expect(decomposePinch(64).n).toBe(3);
    expect(decomposePinch(0.25).n).toBe(1);
    // The worst FP case: log(4^29)/log(4) lands epsilon-high.
    expect(decomposePinch(PINCH_RATIO_PER_GESTURE ** 29).n).toBe(29);
    // Mirror case: |log(4^-29)| can differ from log(4^29) by an ulp.
    expect(decomposePinch(PINCH_RATIO_PER_GESTURE ** -29).n).toBe(29);
  });
});

describe("buildAxisCandidate / selectPinchCandidate", () => {
  it("dispatches one substantial gesture for a portrait-normalized 150×150 target at scale 4", () => {
    // 150×150 px on a 1080×2400 portrait phone: much wider than tall in
    // normalized units — the axis math must use the matching dimension.
    const frame = { width: 150 / 1080, height: 150 / 2400 };
    const selected = pick({ x: 0.5, y: 0.5 }, 4, IOS_GUARDS, frame);

    expect(selected).toBeDefined();
    expect(selected!.angle).toBe(0); // width is the larger normalized span
    expect(selected!.end / selected!.start).toBeCloseTo(4, 9); // full requested ratio
    expect(selected!.travel).toBeGreaterThan(0.3); // substantial, not target-clipped
    expect(selected!.fullyEdgeSafe).toBe(true);
  });

  it("chooses the vertical axis for a tall/narrow target", () => {
    const selected = pick({ x: 0.5, y: 0.5 }, 4, IOS_GUARDS, { width: 0.1, height: 0.6 });
    expect(selected!.angle).toBe(90);
  });

  it("still attempts a tiny target (no minimum size)", () => {
    const selected = pick({ x: 0.5, y: 0.5 }, 4, IOS_GUARDS, { width: 0.01, height: 0.005 });
    expect(selected).toBeDefined();
    expect(selected!.travel).toBeGreaterThan(0);
    expect(selected!.end / selected!.start).toBeCloseTo(4, 9);
  });

  it("runs parallel to the violated edge for a side-edge target", () => {
    // Center inside the left guard: a horizontal pinch would start like an OS
    // back swipe, so the vertical (parallel) candidate must win.
    const selected = pick({ x: 0.05, y: 0.5 }, 4, IOS_GUARDS, { width: 0.1, height: 0.2 });
    expect(selected!.angle).toBe(90);
    expect(selected!.axisSafe).toBe(true);
    expect(selected!.fullyEdgeSafe).toBe(false); // perpendicular coordinate stays in the guard
  });

  it("keeps the ratio and drifts the centroid inward for a corner target", () => {
    // Bottom-left corner (frame x 0–0.3, y 0.86–1.0): center (0.15, 0.93).
    const selected = pick({ x: 0.15, y: 0.93 }, 4, IOS_GUARDS, { width: 0.3, height: 0.14 });

    expect(selected!.angle).toBe(0); // parallel to the violated bottom edge
    expect(selected!.end / selected!.start).toBeCloseTo(4, 9);
    expect(selected!.endCenter).toBeGreaterThan(0.15); // drifted inward
    // Final pointers stay inside the screen inset.
    expect(selected!.endCenter - selected!.end / 2).toBeGreaterThanOrEqual(SCREEN_EDGE_INSET - 1e-9);
    expect(selected!.endCenter + selected!.end / 2).toBeLessThanOrEqual(1 - SCREEN_EDGE_INSET + 1e-9);
  });

  it("keeps Down points within the screen inset when the centroid sits inside a guard", () => {
    // Center x 0.05 is inside the 0.08 left guard: the fallback start span
    // must clamp to the 2% inset, not the full screen span.
    const candidate = buildAxisCandidate({
      angle: 0,
      center: { x: 0.05, y: 0.5 },
      targetSpan: 0.1,
      per: 4,
      guards: IOS_GUARDS,
    });
    expect(candidate).toBeDefined();
    expect(candidate!.start).toBeGreaterThan(0);
    expect(0.05 - candidate!.start / 2).toBeGreaterThanOrEqual(SCREEN_EDGE_INSET - 1e-9);
  });

  it("scores a candidate with its perpendicular coordinate in a guard band as not fully edge-safe", () => {
    // Own axis clear, but both Down points ride the top guard band.
    const candidate = buildAxisCandidate({
      angle: 0,
      center: { x: 0.5, y: 0.03 },
      per: 4,
      guards: IOS_GUARDS,
    });
    expect(candidate!.axisSafe).toBe(true);
    expect(candidate!.fullyEdgeSafe).toBe(false);
  });

  it("guards the same near-side-edge target at 0.13 on android but 0.08 on ios", () => {
    expect(IOS_GUARDS).toEqual({ left: 0.08, right: 0.08, top: 0.08, bottom: 0.08 });
    expect(ANDROID_GUARDS).toEqual({ left: 0.13, right: 0.13, top: 0.08, bottom: 0.08 });

    // Wide target near the left edge (center x 0.15): horizontal clears the
    // iOS 0.08 side guard with room to spare, but not Android's 0.13.
    const center = { x: 0.15, y: 0.5 };
    const frame = { width: 0.3, height: 0.1 };
    expect(pick(center, 4, IOS_GUARDS, frame)!.angle).toBe(0);
    expect(pick(center, 4, ANDROID_GUARDS, frame)!.angle).toBe(90);
  });

  it("tracks injected synthetic guards — the selection flips with the guard data alone", () => {
    const center = { x: 0.5, y: 0.5 };
    const sideGuarded: EdgeGuards = { left: 0.4, right: 0.4, top: 0, bottom: 0 };
    const capGuarded: EdgeGuards = { left: 0, right: 0, top: 0.4, bottom: 0.4 };
    expect(pick(center, 4, sideGuarded)!.angle).toBe(90);
    expect(pick(center, 4, capGuarded)!.angle).toBe(0);
  });

  it("fails only when there is literally no positive on-screen motion", () => {
    expect(selectPinchCandidate([])).toBeUndefined();
    // A centroid at the screen edge has no room on its axis in the fallback.
    expect(
      buildAxisCandidate({ angle: 0, center: { x: 0, y: 0.5 }, per: 4, guards: IOS_GUARDS })
    ).toBeUndefined();
  });

  it("prefers greater starting clearance, then greater travel, among unsafe candidates", () => {
    const mk = (overrides: Partial<PinchCandidate>): PinchCandidate => ({
      angle: 0,
      start: 0.1,
      end: 0.4,
      endCenter: 0.5,
      travel: 0.3,
      viable: true,
      axisSafe: false,
      fullyEdgeSafe: false,
      clearance: -0.05,
      ...overrides,
    });
    expect(
      selectPinchCandidate([mk({ clearance: -0.06 }), mk({ angle: 90, clearance: -0.01 })])!.angle
    ).toBe(90);
    expect(selectPinchCandidate([mk({ travel: 0.1 }), mk({ angle: 90, travel: 0.5 })])!.angle).toBe(
      90
    );
  });
});
