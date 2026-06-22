import { describe, it, expect } from "vitest";
import { renderNativeProfilerReport } from "../../src/utils/ios-profiler/render";
import type {
  CpuHotspot,
  MemoryLeak,
  ProfilerPayload,
  UiHang,
} from "../../src/utils/ios-profiler/types";

// A mangled nested name that the conservative demangler understands:
// _ZN16GrDrawingManager5flushE... → GrDrawingManager::flush (argument list dropped).
const MANGLED = "_ZN16GrDrawingManager5flushE6SkSpanIP14GrSurfaceProxyE";
const DEMANGLED = "GrDrawingManager::flush";

// A second, distinct mangled nested name → MyClass::doWork. Used to prove the
// `responsibleFrame` / leak sites demangle independently of the hang sites.
const MANGLED_LEAK = "_ZN7MyClass6doWorkEv";
const DEMANGLED_LEAK = "MyClass::doWork";

function cpuHotspot(overrides: Partial<CpuHotspot> = {}): CpuHotspot {
  return {
    type: "cpu_hotspot",
    platform: "android",
    dominantFunction: MANGLED,
    totalWeightMs: 120,
    weightPercentage: 42,
    sampleCount: 60,
    thread: "Main Thread",
    severity: "RED",
    topCallChain: [],
    topCallChains: [],
    duringHang: false,
    timeRangeMs: { first: 0, last: 1000 },
    burstWindows: [],
    ...overrides,
  };
}

function payloadWith(hotspot: CpuHotspot): ProfilerPayload {
  return {
    // traceFile null → renderNativeProfilerReport writes no file (hermetic).
    metadata: { traceFile: null, platform: "android", timestamp: "2026-01-01T00:00:00Z" },
    bottlenecks: [hotspot],
  };
}

describe("renderNativeProfilerReport — CPU Hotspots leaf demangling", () => {
  it("shows the DEMANGLED leaf in the table and heading, but keeps the RAW mangled name in the function_callers suggestion", async () => {
    const { report } = await renderNativeProfilerReport({
      payload: payloadWith(cpuHotspot()),
      traceFile: null,
    });

    // (a) Human-facing display sites are demangled.
    // Table cell: `| 1 | `GrDrawingManager::flush` | Main Thread | ...`
    expect(report).toContain(`| 1 | \`${DEMANGLED}\` | Main Thread |`);
    // Detail heading: `### `GrDrawingManager::flush` (Main Thread)`
    expect(report).toContain(`### \`${DEMANGLED}\` (Main Thread)`);
    // Suggested Improvements bullet is demangled too.
    expect(report).toContain(`\`${DEMANGLED}\` on Main Thread`);

    // (b) The copy-paste drill-down MUST keep the RAW mangled symbol — it is
    // matched as a SQL substring of the mangled frame, and the demangled name
    // (args dropped) is not a substring of it.
    expect(report).toContain(`mode=\`function_callers\` function_name=\`${MANGLED}\``);
    // The mangled name must NOT leak into the human-facing table/heading.
    expect(report).not.toContain(`| 1 | \`${MANGLED}\``);
    expect(report).not.toContain(`### \`${MANGLED}\``);
  });

  it("demangles the frames in the per-hotspot Call chains block", async () => {
    // Android builds callChains as [{ chain: [leaf_function] }] — the chain frame
    // is the SAME mangled string as dominantFunction. Without demangling here the
    // heading would read `GrDrawingManager::flush` while the chain right under it
    // shows the raw `_ZN16GrDrawingManager…` for the very same function.
    const { report } = await renderNativeProfilerReport({
      payload: payloadWith(cpuHotspot({ topCallChains: [{ chain: [MANGLED], count: 60 }] })),
      traceFile: null,
    });
    expect(report).toContain(`- (60×) \`${DEMANGLED}\``);
    expect(report).not.toContain(`- (60×) \`${MANGLED}\``);
    // Only the function_callers drill-down keeps the raw mangled name (by design).
    expect(report.split(MANGLED).length - 1).toBe(1);
    expect(report).toContain(`function_name=\`${MANGLED}\``);
  });

  it("demangles the single-chain fallback (`Call chain:`) too", async () => {
    // Reached when topCallChains is empty but a topCallChain is present.
    const { report } = await renderNativeProfilerReport({
      payload: payloadWith(cpuHotspot({ topCallChain: [MANGLED], topCallChains: [] })),
      traceFile: null,
    });
    expect(report).toContain(`**Call chain:** \`${DEMANGLED}\``);
    expect(report).not.toContain(`**Call chain:** \`${MANGLED}\``);
  });

  it("leaves an already-readable (iOS-style) leaf name untouched", async () => {
    // iOS frames arrive pre-symbolicated; the demangler bails on anything that
    // is not an Itanium `_Z…` name, so applying it is a safe no-op.
    const ios = "-[MyViewController viewDidLoad]";
    const { report } = await renderNativeProfilerReport({
      payload: payloadWith(cpuHotspot({ platform: "ios", dominantFunction: ios })),
      traceFile: null,
    });
    expect(report).toContain(`| 1 | \`${ios}\` |`);
    expect(report).toContain(`### \`${ios}\` (Main Thread)`);
  });
});

// ---------------------------------------------------------------------------
// General demangling: hang appCallChains / suspectedFunctions, and memory-leak
// responsibleFrame — in both the detail section AND Suggested Improvements.
// iOS frames are the realistic carrier of mangled C++ names here (Android hang
// appCallChains/suspectedFunctions are hardcoded empty; the SQL path already
// demangles its own callstack text), so these payloads are iOS-flavoured.
// ---------------------------------------------------------------------------

function uiHang(overrides: Partial<UiHang> = {}): UiHang {
  return {
    type: "ui_hang",
    platform: "ios",
    hangType: "hang",
    durationMs: 850,
    startTimeFormatted: "00:01.500",
    startNs: 1_500_000_000,
    endNs: 2_350_000_000,
    suspectedFunctions: [],
    appCallChains: [],
    severity: "RED",
    ...overrides,
  };
}

function memoryLeak(overrides: Partial<MemoryLeak> = {}): MemoryLeak {
  return {
    type: "memory_leak",
    platform: "ios",
    objectType: "MyLeakyObject",
    totalSizeBytes: 4 * 1024 * 1024,
    count: 128,
    responsibleFrame: MANGLED_LEAK,
    responsibleLibrary: "MyApp",
    attributed: true,
    severity: "RED",
    ...overrides,
  };
}

function payloadOf(bottlenecks: ProfilerPayload["bottlenecks"]): ProfilerPayload {
  return {
    metadata: { traceFile: null, platform: "ios", timestamp: "2026-01-01T00:00:00Z" },
    bottlenecks,
  };
}

describe("renderNativeProfilerReport — general native-frame demangling", () => {
  it("demangles a hang's appCallChains frames in the detail section", async () => {
    const { report } = await renderNativeProfilerReport({
      payload: payloadOf([
        uiHang({ appCallChains: [{ chain: [MANGLED, MANGLED_LEAK], sampleCount: 40 }] }),
      ]),
      traceFile: null,
    });
    // Detail: `1. `GrDrawingManager::flush > MyClass::doWork` (40 samples)`
    expect(report).toContain(`1. \`${DEMANGLED} > ${DEMANGLED_LEAK}\` (40 samples)`);
    expect(report).not.toContain(MANGLED);
    expect(report).not.toContain(MANGLED_LEAK);
  });

  it("demangles a hang's suspectedFunctions in BOTH the detail list and Suggested Improvements", async () => {
    const { report } = await renderNativeProfilerReport({
      payload: payloadOf([uiHang({ suspectedFunctions: [MANGLED, MANGLED_LEAK] })]),
      traceFile: null,
    });
    // Detail bullet (the `else if (suspectedFunctions)` branch, no appCallChains):
    expect(report).toContain(`- \`${DEMANGLED}\``);
    expect(report).toContain(`- \`${DEMANGLED_LEAK}\``);
    // Suggested Improvements → UI Hangs "Likely caused by: `…`" uses [0].
    expect(report).toContain(`Likely caused by: \`${DEMANGLED}\`.`);
    // No mangled name anywhere in the report.
    expect(report).not.toContain(MANGLED);
    expect(report).not.toContain(MANGLED_LEAK);
  });

  it("demangles a memory leak's responsibleFrame in BOTH the table and Suggested Improvements", async () => {
    const { report } = await renderNativeProfilerReport({
      payload: payloadOf([memoryLeak({ responsibleFrame: MANGLED_LEAK })]),
      traceFile: null,
    });
    // Memory-Leaks table cell.
    expect(report).toContain(`\`${DEMANGLED_LEAK}\` | MyApp |`);
    // Suggested Improvements → Memory Leaks "via `…`".
    expect(report).toContain(`via \`${DEMANGLED_LEAK}\`:`);
    expect(report).not.toContain(MANGLED_LEAK);
  });

  it("leaves already-readable (iOS-style) frames untouched at every general site (no-op)", async () => {
    const hangFn = "-[DataStore loadAll]";
    const leakFrame = "-[ImageCache store:]";
    const { report } = await renderNativeProfilerReport({
      payload: payloadOf([
        uiHang({
          appCallChains: [{ chain: [hangFn], sampleCount: 12 }],
          suspectedFunctions: [hangFn],
        }),
        memoryLeak({ responsibleFrame: leakFrame }),
      ]),
      traceFile: null,
    });
    // appCallChains detail, Suggested-Improvements hang note, leak table + via — all verbatim.
    expect(report).toContain(`1. \`${hangFn}\` (12 samples)`);
    expect(report).toContain(`Likely caused by: \`${hangFn}\`.`);
    expect(report).toContain(`\`${leakFrame}\` | MyApp |`);
    expect(report).toContain(`via \`${leakFrame}\`:`);
  });
});
