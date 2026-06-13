import { describe, it, expect, vi } from "vitest";
import { tvDescribeTool } from "../src/tools/tv/tv-describe";
import type { TvControlApi, TvDescribeResponse } from "../src/blueprints/tv-control";

// The tool touches `describe()` and `recycleAx()`; the rest is unused here.
function makeApi(
  describe: TvControlApi["describe"],
  recycleAx: TvControlApi["recycleAx"] = vi.fn().mockResolvedValue(undefined)
): TvControlApi {
  return {
    describe,
    recycleAx,
    hierarchy: vi.fn(),
    setFocus: vi.fn(),
    navigate: vi.fn(),
    type: vi.fn(),
    ping: vi.fn(),
  } as unknown as TvControlApi;
}

const populated: TvDescribeResponse = {
  bundleId: "com.nfl.gamecenter",
  focused: { label: "Home", isFocused: true },
  focusable: [{ label: "Home", isFocused: true }, { label: "Games" }],
};

const empty: TvDescribeResponse = {
  bundleId: "com.nfl.gamecenter",
  focused: null,
  focusable: [],
};

async function run(api: TvControlApi) {
  // execute ignores params; the udid only matters for service resolution, which
  // the registry does — here we inject the api directly.
  return tvDescribeTool.execute({ tv: api }, { udid: "x" } as never);
}

describe("tv-describe — empty-state resilience", () => {
  it("returns the populated tree without retrying", async () => {
    const describe = vi.fn().mockResolvedValue(populated);
    const res = await run(makeApi(describe));

    expect(describe).toHaveBeenCalledTimes(1);
    expect(res.focusableCount).toBe(2);
    expect(res.focusedLabel).toBe("Home");
    expect(res.hint).toBeUndefined();
    expect(res.description).not.toContain("Note:");
  });

  it("retries while empty and returns the tree once it populates (app finished loading)", async () => {
    // First two probes hit the splash/loading window, third sees the real UI.
    const describe = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValue(populated);
    const res = await run(makeApi(describe));

    expect(describe).toHaveBeenCalledTimes(3);
    expect(res.focusableCount).toBe(2);
    expect(res.hint).toBeUndefined();
  });

  it("recycles the daemon and recovers when the cache was stale", async () => {
    // The transition-window retries stay empty (stale primaryApp cache), then a
    // recycle rebinds to the real foreground app and the next probe populates.
    const describe = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValue(populated);
    const recycleAx = vi.fn().mockResolvedValue(undefined);
    const res = await run(makeApi(describe, recycleAx));

    expect(describe).toHaveBeenCalledTimes(4);
    expect(recycleAx).toHaveBeenCalledTimes(1);
    expect(res.focusableCount).toBe(2);
    expect(res.hint).toBeUndefined();
  });

  it("exhausts retries, recycles, and surfaces the hint when still empty", async () => {
    const describe = vi.fn().mockResolvedValue(empty);
    const recycleAx = vi.fn().mockResolvedValue(undefined);
    const res = await run(makeApi(describe, recycleAx));

    // 3 transition-window probes + 1 post-recycle probe.
    expect(describe).toHaveBeenCalledTimes(4);
    expect(recycleAx).toHaveBeenCalledTimes(1);
    expect(res.focusableCount).toBe(0);
    expect(res.focusedLabel).toBeNull();
    expect(res.hint).toMatch(/still launching|loading|transition|recycl/i);
    expect(res.description).toContain("Note:");
  });
});
