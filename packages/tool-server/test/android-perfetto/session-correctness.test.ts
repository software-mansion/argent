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
});

describe("renderNativeProfilerReport — freshness note", () => {
  it("renders the stale-trace warning in the report header when provided", async () => {
    const { renderNativeProfilerReport } = await import("../../src/utils/ios-profiler/render");
    const { report } = await renderNativeProfilerReport({
      payload: {
        metadata: { traceFile: null, platform: "Android", timestamp: "2026-01-01T00:00:00.000Z" },
        bottlenecks: [],
      },
      traceFile: null,
      freshnessNote: "> ⚠️ **Stale trace:** this recording was captured 3 days ago",
    });
    expect(report).toContain("Stale trace");
  });
});
