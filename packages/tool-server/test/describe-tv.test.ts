import { describe, it, expect, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";

// The Android empty-focus fallback shells out to uiautomator via describeAndroid;
// stub it so the TV-describe routing can be tested without adb.
const describeAndroidMock = vi.fn();
vi.mock("../src/tools/describe/platforms/android", () => ({
  describeAndroid: (...a: unknown[]) => describeAndroidMock(...a),
}));

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
    navigate: vi.fn(),
    type: vi.fn(),
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

// Android TV target — platform "android" by serial shape.
const ANDROID_TV_DEVICE: DeviceInfo = {
  id: "emulator-5556",
  platform: "android",
  kind: "emulator",
};

describe("describe (TV) — Android skips the focus-engine retries", () => {
  it("does not retry or recycle on an empty Android focus set — one probe then the uiautomator fallback", async () => {
    // On Android TV an empty focus set is steady state, not a transition — the
    // retry loop and the no-op recycle would just repeat the empty dump. One
    // probe, then straight to the full-tree fallback.
    const describeFn = vi.fn().mockResolvedValue(empty);
    const recycleAx = vi.fn().mockResolvedValue(undefined);
    const frame = { x: 0, y: 0, width: 100, height: 50 };
    describeAndroidMock.mockResolvedValue({
      tree: {
        role: "RCTView",
        frame,
        children: [{ role: "AXButton", label: "Play", frame, children: [] }],
      },
      source: "uiautomator",
    });

    const res = await describeTv(makeRegistry(makeApi(describeFn, recycleAx)), ANDROID_TV_DEVICE);

    // Exactly one probe before the fallback — no retry loop, no recycle.
    expect(recycleAx).not.toHaveBeenCalled();
    expect(describeFn).toHaveBeenCalledTimes(1);
    // The Android uiautomator fallback supplied the rendering + its hint.
    expect(describeAndroidMock).toHaveBeenCalledTimes(1);
    expect(res.hint).toMatch(/Android TV focus engine/i);
  });
});
