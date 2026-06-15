import { describe, it, expect, beforeEach, vi } from "vitest";
import { dispatchByPlatform } from "../src/utils/cross-platform-tool";
import { NotImplementedOnPlatformError } from "../src/utils/capability";
import { __resetDepCacheForTests } from "../src/utils/check-deps";
import type { ToolCapability } from "@argent/registry";

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidUdid = "emulator-5554";
const chromiumUdid = "chromium-cdp-19222";

beforeEach(() => {
  __resetDepCacheForTests();
});

describe("dispatchByPlatform (chromium branch)", () => {
  it("routes chromium udids to the chromium handler", async () => {
    const ios = vi.fn().mockResolvedValue("ios");
    const android = vi.fn().mockResolvedValue("android");
    const chromium = vi.fn().mockResolvedValue("chromium");
    const execute = dispatchByPlatform<
      Record<string, never>,
      Record<string, never>,
      { udid: string },
      string,
      Record<string, never>
    >({
      toolId: "test",
      capability,
      ios: { handler: ios },
      android: { handler: android },
      chromium: { handler: chromium },
    });
    expect(await execute({}, { udid: chromiumUdid })).toBe("chromium");
    expect(ios).not.toHaveBeenCalled();
    expect(android).not.toHaveBeenCalled();
    expect(chromium).toHaveBeenCalledOnce();
  });

  it("still routes ios / android correctly when a chromium branch exists", async () => {
    const ios = vi.fn().mockResolvedValue("ios");
    const android = vi.fn().mockResolvedValue("android");
    const chromium = vi.fn().mockResolvedValue("chromium");
    const execute = dispatchByPlatform<
      Record<string, never>,
      Record<string, never>,
      { udid: string },
      string,
      Record<string, never>
    >({
      toolId: "test",
      capability,
      ios: { handler: ios },
      android: { handler: android },
      chromium: { handler: chromium },
    });
    expect(await execute({}, { udid: iosUdid })).toBe("ios");
    expect(await execute({}, { udid: androidUdid })).toBe("android");
    expect(chromium).not.toHaveBeenCalled();
  });

  it("throws NotImplementedOnPlatformError on chromium when no chromium branch is wired", async () => {
    const execute = dispatchByPlatform<
      Record<string, never>,
      Record<string, never>,
      { udid: string },
      string
    >({
      toolId: "ios-android-only",
      capability,
      ios: { handler: async () => "ios" },
      android: { handler: async () => "android" },
    });
    await expect(execute({}, { udid: chromiumUdid })).rejects.toBeInstanceOf(
      NotImplementedOnPlatformError
    );
  });
});
