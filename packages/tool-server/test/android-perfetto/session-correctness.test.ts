import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatTraceFreshness } from "../../src/utils/profiler-shared/freshness";

const MIN = 60_000;

describe("formatTraceFreshness", () => {
  const NOW = 1_700_000_000_000;

  it("returns null for a fresh recording (under the stale threshold)", () => {
    expect(formatTraceFreshness(NOW - 5 * MIN, NOW)).toBeNull();
  });

  it("returns null when the capture time is unknown", () => {
    expect(formatTraceFreshness(null, NOW)).toBeNull();
    expect(formatTraceFreshness(undefined, NOW)).toBeNull();
  });

  it("warns for a recording from a previous session, in days", () => {
    const note = formatTraceFreshness(NOW - 3 * 24 * 60 * MIN, NOW);
    expect(note).toMatch(/Stale trace/);
    expect(note).toMatch(/3 days ago/);
  });

  it("warns in hours for a several-hour-old trace", () => {
    const note = formatTraceFreshness(NOW - 5 * 60 * MIN, NOW);
    expect(note).toMatch(/5 hours ago/);
  });

  it("warns in minutes for a 45-min-old trace (over the 30-min threshold)", () => {
    const note = formatTraceFreshness(NOW - 45 * MIN, NOW);
    expect(note).toMatch(/Stale trace/);
    expect(note).toMatch(/45 minutes ago/);
  });

  it("flags the exact 30-min boundary as stale (ageMs === STALE_AFTER_MS, not < it)", () => {
    const note = formatTraceFreshness(NOW - 30 * MIN, NOW);
    expect(note).toMatch(/30 minutes ago/);
    // One ms under the boundary is still fresh.
    expect(formatTraceFreshness(NOW - (30 * MIN - 1), NOW)).toBeNull();
  });

  it("uses the singular unit at exactly one hour", () => {
    expect(formatTraceFreshness(NOW - 60 * MIN, NOW)).toMatch(/1 hour ago/);
  });

  it("switches minutes→hours at 60 min and hours→days at 48 h", () => {
    // The hours bucket runs up to 47 h (round(2820/60)=47); 48 h rounds into
    // the days bucket as "2 days" — so a singular "1 day" never renders, by
    // construction. Pinning the transition guards the formatAge thresholds.
    expect(formatTraceFreshness(NOW - 47 * 60 * MIN, NOW)).toMatch(/47 hours ago/);
    expect(formatTraceFreshness(NOW - 48 * 60 * MIN, NOW)).toMatch(/2 days ago/);
  });

  it("guards non-finite capture times — never renders NaN / Invalid Date / throws", () => {
    for (const bad of [NaN, Infinity, -Infinity, 0]) {
      expect(formatTraceFreshness(bad, NOW)).toBeNull();
    }
  });

  it("guards an out-of-range epoch (|ms| > max valid Date) — returns null, never throws RangeError", () => {
    // A finite-but-corrupt capturedAtEpochMs (e.g. from a hand-edited
    // .pftrace.metadata.json) past the max valid JS Date ms (8.64e15) would
    // reach `new Date(x).toISOString()` and throw "Invalid time value".
    // Both signs must be guarded.
    expect(() => formatTraceFreshness(9e15, NOW)).not.toThrow();
    expect(() => formatTraceFreshness(-9e15, NOW)).not.toThrow();
    expect(formatTraceFreshness(9e15, NOW)).toBeNull();
    expect(formatTraceFreshness(-9e15, NOW)).toBeNull();

    // Pin the guard against the age-gate masking it: choose a `now` that puts
    // each out-of-range epoch firmly in the "stale" path (positive age past the
    // threshold), so the value genuinely reaches the toISOString() guard, not
    // the earlier `ageMs < STALE_AFTER_MS` short-circuit.
    expect(() => formatTraceFreshness(9e15, 9e15 + 24 * 60 * MIN)).not.toThrow();
    expect(formatTraceFreshness(9e15, 9e15 + 24 * 60 * MIN)).toBeNull();
    expect(() => formatTraceFreshness(-9e15, -9e15 + 24 * 60 * MIN)).not.toThrow();
    expect(formatTraceFreshness(-9e15, -9e15 + 24 * 60 * MIN)).toBeNull();
  });

  it("does NOT over-guard: the exact max valid Date boundary (8.64e15) still renders", () => {
    // 8.64e15 ms is a valid Date (+275760-09-13); the guard uses strict `>`,
    // so the boundary itself must NOT be dropped. Drive it into the stale path
    // and confirm it renders a normal warning without throwing.
    const captured = 8.64e15;
    expect(() => formatTraceFreshness(captured, captured + 60 * MIN)).not.toThrow();
    expect(formatTraceFreshness(captured, captured + 60 * MIN)).toMatch(/Stale trace/);
  });

  it("treats a future capture time as fresh (negative age)", () => {
    expect(formatTraceFreshness(NOW + 5 * MIN, NOW)).toBeNull();
  });
});

// --- app_process validation (adb mocked) ------------------------------------

const adbShell = vi.fn();
vi.mock("../../src/utils/adb", () => ({
  adbShell: (...args: unknown[]) => adbShell(...args),
  shellQuote: (v: string) => `'${v}'`,
}));

import { validateAndroidAppProcess } from "../../src/utils/android-profiler/detect-app";

describe("validateAndroidAppProcess", () => {
  beforeEach(() => adbShell.mockReset());

  it("accepts an installed package", async () => {
    adbShell.mockResolvedValueOnce("package:com.android.systemui\npackage:com.example.app\n");
    await expect(
      validateAndroidAppProcess("emulator-5554", "com.example.app")
    ).resolves.toBeUndefined();
    expect(adbShell).toHaveBeenCalledTimes(1); // no pidof fallback needed
  });

  it("accepts a running (non-package) process via pidof fallback", async () => {
    adbShell
      .mockResolvedValueOnce("package:com.android.systemui\n") // not in pm list
      .mockResolvedValueOnce("2451\n"); // pidof finds it
    await expect(
      validateAndroidAppProcess("emulator-5554", "surfaceflinger")
    ).resolves.toBeUndefined();
  });

  it("rejects a bogus app_process with an actionable error", async () => {
    adbShell
      .mockResolvedValueOnce("package:com.example.app\n") // not the target
      .mockResolvedValueOnce(""); // pidof finds nothing
    await expect(
      validateAndroidAppProcess("emulator-5554", "com.totally.nonexistent.app")
    ).rejects.toThrow(/was not found on emulator-5554/);
  });

  it("surfaces an adb/device error instead of claiming 'not found'", async () => {
    adbShell.mockRejectedValueOnce(new Error("device offline"));
    await expect(validateAndroidAppProcess("emulator-5554", "com.example.app")).rejects.toThrow(
      /Could not verify app_process .* device offline/
    );
  });

  it("models a genuine not-match as pidof RESOLVING empty (`|| true`) → still 'was not found'", async () => {
    // `pidof <missing> || true` exits 0 with empty stdout when nothing matches,
    // so the real adbShell RESOLVES "" rather than rejecting. That still means
    // "no running process" → the actionable not-found error.
    adbShell
      .mockResolvedValueOnce("package:com.example.app\n") // pm list: target absent
      .mockResolvedValueOnce("\n"); // pidof || true: no match, empty stdout
    await expect(
      validateAndroidAppProcess("emulator-5554", "com.totally.nonexistent.app")
    ).rejects.toThrow(/was not found on emulator-5554/);
  });

  it("propagates a pidof transport error as 'Could not verify' — NOT 'was not found'", async () => {
    // With `|| true`, a non-zero exit from a genuine not-match becomes a resolved
    // empty stdout; so a REJECTION here is a real adb/device failure (e.g. the
    // device dropped). Per this function's contract that must propagate with
    // context, not be misread as "process not running".
    adbShell
      .mockResolvedValueOnce("package:com.example.app\n") // pm list: target absent
      .mockRejectedValueOnce(new Error("device offline")); // pidof: real adb failure
    let caught: Error | undefined;
    try {
      await validateAndroidAppProcess("emulator-5554", "com.totally.nonexistent.app");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toMatch(/Could not verify app_process .* device offline/);
    // The whole point: a transport error must NOT be misreported as not-found.
    expect(caught?.message).not.toMatch(/was not found/);
  });
});

describe("renderNativeProfilerReport — freshness note", () => {
  const NOTE = "> ⚠️ **Stale trace:** this recording was captured 3 days ago";

  it("renders the stale-trace warning in the all-clear (zero-bottleneck) header when provided", async () => {
    const { renderNativeProfilerReport } = await import("../../src/utils/ios-profiler/render");
    const { report } = await renderNativeProfilerReport({
      payload: {
        metadata: { traceFile: null, platform: "Android", timestamp: "2026-01-01T00:00:00.000Z" },
        bottlenecks: [],
      },
      traceFile: null,
      freshnessNote: NOTE,
    });
    expect(report).toContain("Stale trace");
  });

  it("renders the stale-trace warning in the FULL report header (with bottlenecks present)", async () => {
    const { renderNativeProfilerReport } = await import("../../src/utils/ios-profiler/render");
    const { report } = await renderNativeProfilerReport({
      payload: {
        metadata: {
          traceFile: "/tmp/native-profiler-x.pftrace",
          platform: "Android",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        // One real CPU hotspot → the renderer takes the full-report branch
        // (renderFullReport), which is where the second freshnessNote push lives.
        bottlenecks: [
          {
            type: "cpu_hotspot",
            platform: "android",
            dominantFunction: "doFrame",
            totalWeightMs: 120,
            weightPercentage: 42,
            sampleCount: 12,
            thread: "Main Thread",
            severity: "RED",
            topCallChain: ["doFrame"],
            topCallChains: [{ chain: ["doFrame"], count: 12 }],
            duringHang: false,
            timeRangeMs: { first: 0, last: 500 },
            burstWindows: [],
          },
        ],
      },
      traceFile: "/tmp/native-profiler-x.pftrace",
      freshnessNote: NOTE,
    });
    expect(report).toContain("Stale trace");
    expect(report).toContain("## Summary"); // confirms we hit the full-report path
  });

  it("omits the freshness header entirely when no note is supplied (fresh trace)", async () => {
    const { renderNativeProfilerReport } = await import("../../src/utils/ios-profiler/render");
    const { report } = await renderNativeProfilerReport({
      payload: {
        metadata: { traceFile: null, platform: "Android", timestamp: "2026-01-01T00:00:00.000Z" },
        bottlenecks: [],
      },
      traceFile: null,
      // no freshnessNote
    });
    expect(report).not.toContain("Stale trace");
  });
});
