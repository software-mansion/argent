import { describe, it, expect } from "vitest";
import { foldHangAnnotations } from "../../src/utils/android-profiler/pipeline/hang-fold";
import type { UiHang } from "../../src/utils/profiler-shared/types";

function buildHang(): UiHang {
  return {
    type: "ui_hang",
    platform: "android",
    hangType: "jank",
    durationMs: 500,
    startTimeFormatted: "00:01.000",
    startNs: 1_000_000_000,
    endNs: 1_500_000_000,
    suspectedFunctions: [],
    appCallChains: [],
    severity: "RED",
    jankReason: "AppDeadlineMissed",
  };
}

describe("foldHangAnnotations", () => {
  it("attaches state breakdown rows with rounded ms durations", () => {
    const hang = buildHang();
    const result = foldHangAnnotations(
      hang,
      [
        { state: "Sleeping", blocked_function: "futex_wait", total_dur_ns: 400_000_000, occurrences: 1 },
        { state: "Running", blocked_function: null, total_dur_ns: 100_000_000, occurrences: 1 },
      ],
      []
    );
    expect(result.stateBreakdown).toEqual([
      { state: "Sleeping", blockedFunction: "futex_wait", durationMs: 400 },
      { state: "Running", blockedFunction: null, durationMs: 100 },
    ]);
  });

  it("computes gcOverlapMs by intersecting GC slices with the hang window", () => {
    const hang = buildHang();
    const result = foldHangAnnotations(hang, [], [
      // 200ms fully inside the window
      { gc_reason: "GC: concurrent copying", ts_ns: 1_100_000_000, dur_ns: 200_000_000 },
      // 100ms overlap on the left (slice starts before window)
      { gc_reason: "GC: kGcCauseExplicit", ts_ns: 900_000_000, dur_ns: 200_000_000 },
    ]);
    // 200 + 100 = 300ms total
    expect(result.gcOverlapMs).toBe(300);
  });

  it("omits gcOverlapMs when no overlap exists", () => {
    const hang = buildHang();
    const result = foldHangAnnotations(hang, [], []);
    expect(result.gcOverlapMs).toBeUndefined();
  });

  it("omits stateBreakdown when no rows are folded in", () => {
    const hang = buildHang();
    const result = foldHangAnnotations(hang, [], []);
    expect(result.stateBreakdown).toBeUndefined();
  });

  it("preserves the original hang fields (no mutation)", () => {
    const hang = buildHang();
    const result = foldHangAnnotations(
      hang,
      [{ state: "Running", blocked_function: null, total_dur_ns: 1_000_000, occurrences: 1 }],
      []
    );
    expect(result.hangType).toBe("jank");
    expect(result.jankReason).toBe("AppDeadlineMissed");
    expect(result.startNs).toBe(1_000_000_000);
    expect(hang.stateBreakdown).toBeUndefined(); // original not mutated
  });
});
