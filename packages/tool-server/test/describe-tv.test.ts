import { describe, it, expect, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { describeTv } from "../src/tools/describe/platforms/tv";
import type { TvControlApi, TvDescribeResponse } from "../src/blueprints/tv-control";

// The tool touches `describe()` and `recycleAx()`; the rest is unused here.
function makeApi(
  describeFn: TvControlApi["describe"],
  recycleAx: TvControlApi["recycleAx"] = vi.fn().mockResolvedValue(undefined)
): TvControlApi {
  return {
    describe: describeFn,
    recycleAx,
    hierarchy: vi.fn(),
    setFocus: vi.fn(),
    navigate: vi.fn(),
    type: vi.fn(),
    ping: vi.fn(),
  } as unknown as TvControlApi;
}

// describeTv resolves the TvControlApi through the registry; the unit tests
// inject it directly by stubbing resolveService.
function makeRegistry(api: TvControlApi) {
  return { resolveService: vi.fn(async () => api) } as never;
}

// Apple TV target — platform "ios" by UDID shape, so no Android fallback fires.
const TVOS_DEVICE: DeviceInfo = {
  id: "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD",
  platform: "ios",
  kind: "simulator",
};

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
  return describeTv(makeRegistry(api), TVOS_DEVICE);
}

describe("describe (TV) — empty-state resilience", () => {
  it("returns the populated focus view without retrying", async () => {
    const describeFn = vi.fn().mockResolvedValue(populated);
    const res = await run(makeApi(describeFn));

    expect(describeFn).toHaveBeenCalledTimes(1);
    expect(res.source).toBe("tv-focus");
    expect(res.description).toContain("Focused: Home");
    expect(res.description).toContain("Focusable (2):");
    expect(res.hint).toBeUndefined();
    expect(res.description).not.toContain("Note:");
  });

  it("retries while empty and returns the tree once it populates (app finished loading)", async () => {
    // First two probes hit the splash/loading window, third sees the real UI.
    const describeFn = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValue(populated);
    const res = await run(makeApi(describeFn));

    expect(describeFn).toHaveBeenCalledTimes(3);
    expect(res.description).toContain("Focusable (2):");
    expect(res.hint).toBeUndefined();
  });

  it("recycles the daemon and recovers when the cache was stale", async () => {
    // The transition-window retries stay empty (stale primaryApp cache), then a
    // recycle rebinds to the real foreground app and the next probe populates.
    const describeFn = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValue(populated);
    const recycleAx = vi.fn().mockResolvedValue(undefined);
    const res = await run(makeApi(describeFn, recycleAx));

    expect(describeFn).toHaveBeenCalledTimes(4);
    expect(recycleAx).toHaveBeenCalledTimes(1);
    expect(res.description).toContain("Focusable (2):");
    expect(res.hint).toBeUndefined();
  });

  it("exhausts retries, recycles, and surfaces the hint when still empty", async () => {
    const describeFn = vi.fn().mockResolvedValue(empty);
    const recycleAx = vi.fn().mockResolvedValue(undefined);
    const res = await run(makeApi(describeFn, recycleAx));

    // 3 transition-window probes + 1 post-recycle probe.
    expect(describeFn).toHaveBeenCalledTimes(4);
    expect(recycleAx).toHaveBeenCalledTimes(1);
    expect(res.description).toContain("Focusable: (none reported)");
    expect(res.hint).toMatch(/still launching|loading|transition|recycl/i);
    expect(res.description).toContain("Note:");
  });
});
