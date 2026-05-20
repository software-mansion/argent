import { describe, it, expect, beforeEach, vi } from "vitest";
import { dispatchByPlatform } from "../src/utils/cross-platform-tool";
import { NotImplementedOnPlatformError } from "../src/utils/capability";
import { __resetDepCacheForTests } from "../src/utils/check-deps";
import type { ToolCapability } from "@argent/registry";

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  electron: { app: true },
};

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidUdid = "emulator-5554";
const electronUdid = "electron-cdp-19222";

beforeEach(() => {
  __resetDepCacheForTests();
});

describe("dispatchByPlatform (electron branch)", () => {
  it("routes electron udids to the electron handler", async () => {
    const ios = vi.fn().mockResolvedValue("ios");
    const android = vi.fn().mockResolvedValue("android");
    const electron = vi.fn().mockResolvedValue("electron");
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
      electron: { handler: electron },
    });
    expect(await execute({}, { udid: electronUdid })).toBe("electron");
    expect(ios).not.toHaveBeenCalled();
    expect(android).not.toHaveBeenCalled();
    expect(electron).toHaveBeenCalledOnce();
  });

  it("still routes ios / android correctly when an electron branch exists", async () => {
    const ios = vi.fn().mockResolvedValue("ios");
    const android = vi.fn().mockResolvedValue("android");
    const electron = vi.fn().mockResolvedValue("electron");
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
      electron: { handler: electron },
    });
    expect(await execute({}, { udid: iosUdid })).toBe("ios");
    expect(await execute({}, { udid: androidUdid })).toBe("android");
    expect(electron).not.toHaveBeenCalled();
  });

  it("throws NotImplementedOnPlatformError on electron when no electron branch is wired", async () => {
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
    await expect(execute({}, { udid: electronUdid })).rejects.toBeInstanceOf(
      NotImplementedOnPlatformError
    );
  });
});
