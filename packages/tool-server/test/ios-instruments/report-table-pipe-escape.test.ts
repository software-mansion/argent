import { describe, it, expect } from "vitest";
import { renderNativeProfilerReport } from "../../src/utils/ios-profiler/render";
import {
  renderFunctionCallersIos,
  renderThreadBreakdownIos,
} from "../../src/tools/profiler/query/profiler-stack-query";
import type { ProfilerPayload, CpuSample } from "../../src/utils/ios-profiler/types";
import type { CpuHotspot } from "../../src/utils/profiler-shared/types";

// GFM splits a table row on every unescaped `|`, even inside a code span, so a
// demangled C++ frame such as `folly::operator|(...)` injects phantom columns
// and misaligns every cell after it. escapeMarkdownTableCell fixes this, but the
// leak tables were the only cells escaped initially — these tables interpolate
// the SAME demangleSymbol() output. dominantFunction is a real demangled frame
// in every capture mode (unlike leak frames, which need malloc_stack_logging),
// so a C++ operator| hotspot reaches all of them without any special setup.
const OP_FRAME = "folly::operator|(folly::Range<char const*>, folly::Range<char const*>)";

// Splitting on unescaped pipes must give the row the same column count as its
// header — the whole point of escaping.
const unescapedCells = (s: string) => s.split(/(?<!\\)\|/).length;

function hotspot(dominantFunction: string, thread = "Main Thread"): CpuHotspot {
  return {
    type: "cpu_hotspot",
    platform: "ios",
    dominantFunction,
    totalWeightMs: 1234,
    weightPercentage: 42,
    sampleCount: 99,
    thread,
    severity: "RED",
    topCallChain: [],
    topCallChains: [],
    duringHang: false,
    timeRangeMs: { first: 0, last: 1000 },
    burstWindows: [],
  };
}

function sample(threadFmt: string, stackNames: string[]): CpuSample {
  return {
    timestampNs: 0,
    threadFmt,
    weightNs: 1_000_000,
    stack: stackNames.map((name) => ({ name, isSystemLibrary: false })),
  };
}

describe("report table pipe-escaping (finding 5: beyond the leak tables)", () => {
  it("escapes a demangled operator| frame in the CPU Hotspots summary table", async () => {
    const payload: ProfilerPayload = {
      metadata: { traceFile: null, platform: "iOS", timestamp: "2026-07-09T00:00:00Z" },
      bottlenecks: [hotspot(OP_FRAME)],
    };
    const res = await renderNativeProfilerReport({ payload, traceFile: null });

    const header = res.report.split("\n").find((l) => l.startsWith("| # | Function | Thread"));
    const row = res.report.split("\n").find((l) => l.includes("folly::operator"));
    expect(header).toBeDefined();
    expect(row).toBeDefined();
    expect(row).toContain("operator\\|");
    expect(unescapedCells(row!)).toBe(unescapedCells(header!));
  });

  it("escapes operator| in the function Called By / Calls Into tables", () => {
    // "target" is called by op| and calls into op| — both caller and callee
    // cells carry the pipe.
    const samples = [
      sample("Main Thread", ["callee", "target", OP_FRAME]),
      sample("Main Thread", [OP_FRAME, "target", "callee2"]),
    ];
    const out = renderFunctionCallersIos(samples, "target", 10);

    const header = out.split("\n").find((l) => l === "| Function | Samples |");
    expect(header).toBeDefined();
    const rows = out.split("\n").filter((l) => l.includes("folly::operator"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toContain("operator\\|");
      expect(unescapedCells(row)).toBe(unescapedCells(header!));
    }
  });

  it("escapes operator| in the per-thread Hotspots table", () => {
    const samples = [sample("Main Thread", ["target"])];
    const out = renderThreadBreakdownIos(samples, [hotspot(OP_FRAME, "Main Thread")], "Main", 10);

    const header = out.split("\n").find((l) => l.startsWith("| Function | Weight (ms)"));
    const row = out.split("\n").find((l) => l.includes("folly::operator"));
    expect(header).toBeDefined();
    expect(row).toBeDefined();
    expect(row).toContain("operator\\|");
    expect(unescapedCells(row!)).toBe(unescapedCells(header!));
  });
});
