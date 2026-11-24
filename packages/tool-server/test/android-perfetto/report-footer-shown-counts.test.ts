import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderNativeProfilerReport } from "../../src/utils/ios-profiler/render";
import type {
  CpuHotspot,
  MemoryRssGrowth,
  ProfilerPayload,
  UiHang,
} from "../../src/utils/ios-profiler/types";

// The "Full report saved" footer must only name the bottleneck categories it
// actually shows. "top 0 CPU hotspots" (the issue #629 stackless trace) and its
// mirror "top 0 hangs" (a hotspot/RSS-only trace) both read as report
// artifacts. The footer only renders when a report file is written, hence the
// real temp traceFile.

function cpuHotspot(): CpuHotspot {
  return {
    type: "cpu_hotspot",
    platform: "android",
    dominantFunction: "writel",
    totalWeightMs: 120,
    weightPercentage: 42,
    sampleCount: 60,
    thread: "RenderThread",
    severity: "RED",
    topCallChain: [],
    topCallChains: [],
    duringHang: false,
    timeRangeMs: { first: 0, last: 1000 },
    burstWindows: [],
  };
}

function uiHang(): UiHang {
  return {
    type: "ui_hang",
    platform: "android",
    hangType: "jank",
    durationMs: 40,
    startTimeFormatted: "00:01.000",
    startNs: 1_000_000_000,
    endNs: 1_040_000_000,
    suspectedFunctions: [],
    appCallChains: [],
    severity: "YELLOW",
  };
}

function rssGrowth(): MemoryRssGrowth {
  return {
    type: "memory_rss_growth",
    platform: "android",
    startMb: 100,
    peakMb: 180,
    growthMb: 80,
    severity: "YELLOW",
  };
}

function payload(bottlenecks: ProfilerPayload["bottlenecks"], traceFile: string): ProfilerPayload {
  return {
    metadata: { traceFile, platform: "android", timestamp: "2026-01-01T00:00:00Z" },
    bottlenecks,
  };
}

describe("report footer — shown-count phrasing", () => {
  let tempDir: string;
  let traceFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "argent-footer-"));
    traceFile = join(tempDir, "native-profiler-x.pftrace");
    await writeFile(traceFile, "", "utf8");
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function footerFor(bottlenecks: ProfilerPayload["bottlenecks"]): Promise<string> {
    const { report } = await renderNativeProfilerReport({
      payload: payload(bottlenecks, traceFile),
      traceFile,
    });
    const footer = report.split("\n").find((l) => l.includes("Full report saved"));
    expect(footer).toBeDefined();
    return footer as string;
  }

  it("names both categories when both are shown", async () => {
    const footer = await footerFor([cpuHotspot(), uiHang()]);
    expect(footer).toContain("showing top 1 CPU hotspots and top 1 hangs inline");
  });

  it("omits CPU hotspots from a hangs-only footer (the issue #629 stackless trace)", async () => {
    const footer = await footerFor([uiHang(), uiHang()]);
    expect(footer).toContain("showing top 2 hangs inline");
    expect(footer).not.toContain("top 0 CPU hotspots");
  });

  it("omits hangs from a hotspots-only footer (the mirror case)", async () => {
    const footer = await footerFor([cpuHotspot(), rssGrowth()]);
    expect(footer).toContain("showing top 1 CPU hotspots inline");
    expect(footer).not.toContain("top 0 hangs");
  });

  it("falls back cleanly when neither category is shown (RSS-growth-only trace)", async () => {
    const footer = await footerFor([rssGrowth()]);
    expect(footer).toContain("1 bottleneck(s) total, summary inline");
    expect(footer).not.toContain("top 0");
    expect(footer).not.toContain("showing  inline");
  });
});
