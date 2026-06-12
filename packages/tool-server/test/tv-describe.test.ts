import { describe, it, expect, vi } from "vitest";
import { tvDescribeTool } from "../src/tools/tv/tv-describe";
import type { TvControlApi, TvDescribeResponse } from "../src/blueprints/tv-control";

// The tool only ever touches `describe()`; the rest of the API is unused here.
function makeApi(describe: TvControlApi["describe"]): TvControlApi {
  return {
    describe,
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

  it("exhausts retries and surfaces the loading hint when still empty", async () => {
    const describe = vi.fn().mockResolvedValue(empty);
    const res = await run(makeApi(describe));

    expect(describe).toHaveBeenCalledTimes(3);
    expect(res.focusableCount).toBe(0);
    expect(res.focusedLabel).toBeNull();
    expect(res.hint).toMatch(/still launching|loading|transition/i);
    expect(res.description).toContain("Note:");
  });
});
