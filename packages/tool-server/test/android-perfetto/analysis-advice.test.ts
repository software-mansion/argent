import { describe, it, expect } from "vitest";
import {
  classifyNativeFrame,
  summarizeHangBlocking,
} from "../../src/utils/profiler-shared/native-frame-class";
import { renderNativeProfilerReport } from "../../src/utils/ios-profiler/render";
import type { CpuHotspot, UiHang, ProfilerPayload } from "../../src/utils/profiler-shared/types";

describe("classifyNativeFrame", () => {
  it("flags goldfish/QEMU emulator GPU-transport frames as system", () => {
    expect(classifyNativeFrame("goldfish_pipe_read_write")).toBe("system");
    expect(classifyNativeFrame("qemu_pipe_read")).toBe("system");
  });

  it("flags Linux kernel syscall/mm frames as system", () => {
    expect(classifyNativeFrame("do_syscall_64")).toBe("system");
    expect(classifyNativeFrame("gup_fast_fallback")).toBe("system");
    expect(classifyNativeFrame("__x64_sys_read")).toBe("system");
  });

  it("matches a system frame even when the leaf name is C++-mangled", () => {
    // perf stores mangled names; the bare symbol still appears as a substring.
    expect(classifyNativeFrame("_Z23__pthread_internal_findlPKc")).toBe("system");
  });

  it("treats real app / RN frames as app code", () => {
    expect(classifyNativeFrame("facebook::react::JSIExecutor::callFunction")).toBe("app");
    expect(classifyNativeFrame("_ZN16GrDrawingManager5flushE")).toBe("app");
    expect(classifyNativeFrame(null)).toBe("app");
  });
});

describe("summarizeHangBlocking", () => {
  it("returns null with no state breakdown", () => {
    expect(summarizeHangBlocking(undefined)).toBeNull();
    expect(summarizeHangBlocking([])).toBeNull();
  });

  it("classifies a sleep-dominated hang as blocked", () => {
    const r = summarizeHangBlocking([
      { state: "S", blockedFunction: null, durationMs: 44 },
      { state: "Running", blockedFunction: null, durationMs: 4 },
    ]);
    expect(r).toEqual({ dominantState: "S", kind: "blocked" });
  });

  it("classifies a Running-dominated hang as executing", () => {
    const r = summarizeHangBlocking([
      { state: "Running", blockedFunction: null, durationMs: 40 },
      { state: "S", blockedFunction: null, durationMs: 4 },
    ]);
    expect(r?.kind).toBe("executing");
  });

  it("classifies an R/R+-dominated hang as runnable", () => {
    const r = summarizeHangBlocking([{ state: "R+", blockedFunction: null, durationMs: 30 }]);
    expect(r?.kind).toBe("runnable");
  });
});

// --- render-level assertions -------------------------------------------------

function hotspot(over: Partial<CpuHotspot>): CpuHotspot {
  return {
    type: "cpu_hotspot",
    platform: "android",
    dominantFunction: "fn",
    totalWeightMs: 100,
    weightPercentage: 20,
    sampleCount: 10,
    thread: "RenderThread",
    severity: "RED",
    topCallChain: [],
    topCallChains: [],
    duringHang: false,
    timeRangeMs: { first: 0, last: 1000 },
    burstWindows: [],
    ...over,
  };
}

function hang(over: Partial<UiHang>): UiHang {
  return {
    type: "ui_hang",
    platform: "android",
    hangType: "jank",
    durationMs: 48,
    startTimeFormatted: "00:05.732",
    startNs: 0,
    endNs: 48_000_000,
    suspectedFunctions: [],
    appCallChains: [],
    severity: "RED",
    ...over,
  };
}

async function reportFor(bottlenecks: ProfilerPayload["bottlenecks"]): Promise<string> {
  const payload: ProfilerPayload = {
    metadata: { traceFile: null, platform: "Android", timestamp: "2026-01-01T00:00:00.000Z" },
    bottlenecks,
  };
  // traceFile null → no file write, inline report returned.
  const { report } = await renderNativeProfilerReport({ payload, traceFile: null });
  return report;
}

describe("renderNativeProfilerReport — Android advice", () => {
  it("labels emulator/kernel CPU hotspots and does not give them app advice", async () => {
    const report = await reportFor([
      hotspot({ dominantFunction: "goldfish_pipe_read_write", frameClass: "system" }),
    ]);
    expect(report).toContain("emulator/kernel");
    expect(report).toMatch(/Re-profile on a real device/);
    // The old blanket advice must not be attached to a system frame.
    expect(report).not.toContain("reduce view hierarchy depth");
  });

  it("gives actionable advice for a real app CPU hotspot", async () => {
    const report = await reportFor([
      hotspot({ dominantFunction: "myHotFunction", thread: "JS/Hermes", frameClass: "app" }),
    ]);
    expect(report).toContain("function_callers");
    expect(report).not.toContain("emulator/kernel overhead");
  });

  it("tells the user a sleep-dominated hang is a wait, not heavy work", async () => {
    const report = await reportFor([
      hang({
        jankReason: "App Deadline Missed",
        stateBreakdown: [
          { state: "S", blockedFunction: null, durationMs: 44 },
          { state: "Running", blockedFunction: null, durationMs: 4 },
        ],
      }),
    ]);
    expect(report).toMatch(/off-CPU|waiting/);
    expect(report).not.toContain("move heavy work to background queue");
  });

  it("still recommends moving work off-thread for a CPU-bound hang", async () => {
    const report = await reportFor([
      hang({
        stateBreakdown: [{ state: "Running", blockedFunction: null, durationMs: 40 }],
      }),
    ]);
    expect(report).toMatch(/on-CPU|executing/);
    expect(report).toContain("Move heavy work off the main thread");
  });

  it("Next Steps function_callers skips a leading system hotspot and picks the first app frame", async () => {
    const report = await reportFor([
      hotspot({ dominantFunction: "goldfish_pipe_read_write", frameClass: "system" }),
      hotspot({ dominantFunction: "do_syscall_64", frameClass: "system" }),
      hotspot({ dominantFunction: "myAppHotFunction", thread: "JS/Hermes", frameClass: "app" }),
    ]);
    // The callers suggestion must not point at a system frame the report just
    // flagged as not directly actionable.
    expect(report).toContain("mode=`function_callers` function_name=`myAppHotFunction`");
    expect(report).not.toContain("function_name=`goldfish_pipe_read_write`");
    expect(report).not.toContain("function_name=`do_syscall_64`");
  });

  it("Next Steps omits function_callers when every hotspot is a system frame", async () => {
    const report = await reportFor([
      hotspot({ dominantFunction: "goldfish_pipe_read_write", frameClass: "system" }),
      hotspot({ dominantFunction: "do_syscall_64", frameClass: "system" }),
    ]);
    // All system → no actionable callers target, so omit the line entirely
    // rather than contradict the "not directly actionable" note above.
    expect(report).not.toContain("function_callers");
    // Sibling Next Steps guidance is still present.
    expect(report).toContain("mode=`thread_breakdown`");
  });

  it("Next Steps suggests the top hotspot on iOS (no frameClass) — unchanged", async () => {
    const report = await reportFor([
      hotspot({ platform: "ios", dominantFunction: "iosTopFn", frameClass: undefined }),
      hotspot({ platform: "ios", dominantFunction: "iosSecondFn", frameClass: undefined }),
    ]);
    // undefined frameClass is treated as non-system, so iOS keeps using [0].
    expect(report).toContain("mode=`function_callers` function_name=`iosTopFn`");
    expect(report).not.toContain("function_name=`iosSecondFn`");
  });
});
