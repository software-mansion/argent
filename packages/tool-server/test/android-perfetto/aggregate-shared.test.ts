import { describe, it, expect } from "vitest";
import {
  aggregateCpuHotspots,
  type AggregatorInputRow,
} from "../../src/utils/profiler-shared/aggregate";

describe("aggregateCpuHotspots (shared)", () => {
  it("returns [] when given no rows", () => {
    expect(aggregateCpuHotspots([], { platform: "ios" })).toEqual([]);
  });

  it("filters out groups below the 3% weight floor", () => {
    const rows: AggregatorInputRow[] = [
      // 95% of weight — main hotspot
      {
        dominantFunction: "hotFn",
        thread: "Main Thread",
        weightNs: 95_000_000,
        timestampsNs: [10_000_000],
        callChains: [{ chain: ["hotFn"], count: 1 }],
      },
      // 5% noise — surfaces as a YELLOW hotspot
      {
        dominantFunction: "warmFn",
        thread: "Main Thread",
        weightNs: 5_000_000,
        timestampsNs: [20_000_000],
        callChains: [{ chain: ["warmFn"], count: 1 }],
      },
      // 0.1% — should be dropped
      {
        dominantFunction: "coldFn",
        thread: "Main Thread",
        weightNs: 100_000,
        timestampsNs: [30_000_000],
        callChains: [{ chain: ["coldFn"], count: 1 }],
      },
    ];
    const out = aggregateCpuHotspots(rows, { platform: "android" });
    const fns = out.map((b) => b.dominantFunction);
    expect(fns).toContain("hotFn");
    expect(fns).toContain("warmFn");
    expect(fns).not.toContain("coldFn");
  });

  it("emits severity RED above 15% and YELLOW between 3-15%", () => {
    const rows: AggregatorInputRow[] = [
      {
        dominantFunction: "bigFn",
        thread: "T",
        weightNs: 50_000_000,
        timestampsNs: [1],
        callChains: [],
      },
      {
        dominantFunction: "smallFn",
        thread: "T",
        weightNs: 5_000_000,
        timestampsNs: [1],
        callChains: [],
      },
    ];
    const out = aggregateCpuHotspots(rows, { platform: "android" });
    const big = out.find((b) => b.dominantFunction === "bigFn")!;
    const small = out.find((b) => b.dominantFunction === "smallFn")!;
    expect(big.severity).toBe("RED");
    expect(small.severity).toBe("YELLOW");
  });

  it("stamps platform field on the emitted hotspot", () => {
    const rows: AggregatorInputRow[] = [
      {
        dominantFunction: "fn",
        thread: "Main Thread",
        weightNs: 100_000_000,
        timestampsNs: [1],
        callChains: [],
      },
    ];
    const ios = aggregateCpuHotspots(rows, { platform: "ios" });
    const android = aggregateCpuHotspots(rows, { platform: "android" });
    expect(ios[0]!.platform).toBe("ios");
    expect(android[0]!.platform).toBe("android");
  });

  it("breaks samples into burst windows on >500ms gaps", () => {
    const rows: AggregatorInputRow[] = [
      {
        dominantFunction: "fn",
        thread: "Main Thread",
        weightNs: 100_000_000,
        // Two clusters: [0, 100ms, 200ms] then [1000ms, 1100ms]
        timestampsNs: [0, 100_000_000, 200_000_000, 1_000_000_000, 1_100_000_000],
        callChains: [],
      },
    ];
    const out = aggregateCpuHotspots(rows, { platform: "android" });
    expect(out[0]!.burstWindows.length).toBe(2);
    expect(out[0]!.burstWindows[0]!.sampleCount).toBe(3);
    expect(out[0]!.burstWindows[1]!.sampleCount).toBe(2);
  });

  it("flags duringHang when any sample timestamp matches the hang set", () => {
    const rows: AggregatorInputRow[] = [
      {
        dominantFunction: "fn",
        thread: "T",
        weightNs: 100_000_000,
        timestampsNs: [50, 100, 150],
        callChains: [],
      },
    ];
    const hung = aggregateCpuHotspots(rows, {
      platform: "ios",
      hangSampleTimestamps: new Set([100]),
    });
    const clean = aggregateCpuHotspots(rows, { platform: "ios" });
    expect(hung[0]!.duringHang).toBe(true);
    expect(clean[0]!.duringHang).toBe(false);
  });
});
