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

  it("flags arm64 (aarch64) kernel syscall-entry + exception-vector leaves as system", () => {
    // The Android profiler runs on an arm64 emulator/device, whose kernel
    // entry-path symbols are named entirely differently from x86-64: the EL0
    // synchronous-exception vector dispatches to the SVC (syscall) handler,
    // which calls invoke_syscall → __arm64_sys_<name>. None of the x86 patterns
    // (do_syscall_64 / entry_SYSCALL_64 / x64_sys_call) match these, so without
    // arm64 patterns these kernel leaves were misclassified as `app` and got
    // app-flavoured advice. arch/arm64/kernel/{entry.S,entry-common.c,syscall.c}.
    for (const leaf of [
      "el0t_64_sync",
      "el0t_64_sync_handler",
      "el0_svc",
      "el0_svc_common",
      "do_el0_svc",
      "invoke_syscall",
      "el0_da", // data-abort (page-fault) handler
      "el0_ia", // instruction-abort handler
      "__arm64_sys_read",
      "__arch_copy_from_user", // arm64 uaccess copy helpers (copy_{from,to}_user.S)
      "__arch_copy_to_user",
    ]) {
      expect(classifyNativeFrame(leaf), `${leaf} should be system`).toBe("system");
    }
  });

  it("does not misclassify app frames that merely resemble arm64 kernel tokens", () => {
    // The arm64 patterns are word-boundaried so distinctive kernel tokens do not
    // bleed into legitimate app symbols (e.g. a bare `vectors` substring would
    // collide with std::vector). Guard against that regressing.
    for (const leaf of [
      "std::vector<int>::push_back",
      "myVectorsHelper",
      "el0_svc_handler_factory_app",
      "MainActivity.onCreate",
      "nativeRender",
      "folly::detail::function::FunctionTraits",
    ]) {
      expect(classifyNativeFrame(leaf), `${leaf} should stay app`).toBe("app");
    }
  });

  it("treats real app / RN frames as app code", () => {
    expect(classifyNativeFrame("facebook::react::JSIExecutor::callFunction")).toBe("app");
    expect(classifyNativeFrame("_ZN16GrDrawingManager5flushE")).toBe("app");
    expect(classifyNativeFrame(null)).toBe("app");
  });
});

describe("classifyNativeFrame — mapping-based classification", () => {
  it("classes a kernel-mapped leaf as system even when NO name pattern matches", () => {
    // These are real arm64-emulator hotspot leaves whose names match none of the
    // SYSTEM_FRAME_PATTERNS (writel is a goldfish/QEMU MMIO write; mod_node_state
    // is vmstat accounting), so they were misclassified as `app`. Without the
    // mapping signal they are indistinguishable from app code by name alone.
    expect(classifyNativeFrame("writel")).toBe("app"); // name-only: misses
    expect(classifyNativeFrame("mod_node_state")).toBe("app"); // name-only: misses
    // With the leaf's `/kernel` mapping, both are unambiguously system.
    for (const leaf of [
      "writel",
      "mod_node_state",
      "mod_node_page_state",
      "try_to_wake_up",
      "_raw_spin_unlock_irqrestore",
      "arch_counter_get_cntvct",
    ]) {
      expect(classifyNativeFrame(leaf, "/kernel"), `${leaf} @ /kernel should be system`).toBe(
        "system"
      );
    }
  });

  it("accepts the common Perfetto/simpleperf kernel-mapping variants", () => {
    expect(classifyNativeFrame("writel", "[kernel.kallsyms]")).toBe("system");
    expect(classifyNativeFrame("writel", "kallsyms")).toBe("system");
    expect(classifyNativeFrame("writel", "/some/path/kallsyms")).toBe("system");
  });

  it("falls back to name patterns for user-space (.so) mappings", () => {
    // A user-space mapping is NOT the kernel, so the name patterns still decide:
    // a gfxstream/goldfish encoder living in a .so is still system overhead...
    expect(classifyNativeFrame("goldfish_pipe_read_write", "/vendor/lib64/libGLESv2_enc.so")).toBe(
      "system"
    );
    expect(classifyNativeFrame("gfxstream_vk_thing", "/vendor/lib64/libvulkan_enc.so")).toBe(
      "system"
    );
    // ...but an ordinary app/framework symbol in a .so stays app.
    expect(classifyNativeFrame("_ZN12GrRenderTask10makeClosedEv", "/system/lib64/libhwui.so")).toBe(
      "app"
    );
    expect(classifyNativeFrame("MainActivity.onCreate", "/data/app/com.example/lib/base.apk")).toBe(
      "app"
    );
  });

  it("does NOT treat a real module path as kernel (no over-broadening)", () => {
    // The kernel test must not match real module paths, or every user-space leaf
    // would be wrongly flagged system. A plain app symbol in a real module stays app.
    for (const mapping of [
      "/system/lib64/libhwui.so",
      "/apex/com.android.art/lib64/libart.so",
      "/vendor/lib64/libGLESv2_enc.so",
      "/data/app/com.example/lib/base.apk",
    ]) {
      expect(classifyNativeFrame("someAppSymbol", mapping), `${mapping} must not be kernel`).toBe(
        "app"
      );
    }
  });

  it("is unchanged on the no-mapping (iOS) path", () => {
    // iOS passes no mapping; classification must be byte-identical to name-only.
    expect(classifyNativeFrame("writel")).toBe("app");
    expect(classifyNativeFrame("writel", undefined)).toBe("app");
    expect(classifyNativeFrame("goldfish_pipe_read_write")).toBe("system");
    expect(classifyNativeFrame("goldfish_pipe_read_write", undefined)).toBe("system");
    expect(classifyNativeFrame("facebook::react::JSIExecutor::callFunction", undefined)).toBe(
      "app"
    );
    // A null/empty mapping must not crash and falls through to the name patterns.
    expect(classifyNativeFrame("writel", null)).toBe("app");
    expect(classifyNativeFrame("do_syscall_64", null)).toBe("system");
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
