import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  dispatchByPlatform,
  type PlatformImpl,
} from "../src/utils/cross-platform-tool";
import {
  __resetDepCacheForTests,
  __primeDepCacheForTests,
} from "../src/utils/check-deps";
import { UnsupportedOperationError } from "../src/utils/capability";
import type { ToolCapability } from "@argent/registry";

const capabilityBoth: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

const capabilityIosOnly: ToolCapability = {
  apple: { simulator: true, device: true },
};

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidUdid = "emulator-5554";

beforeEach(() => {
  __resetDepCacheForTests();
});

describe("dispatchByPlatform", () => {
  it("routes iOS UDIDs to the ios handler and Android serials to the android handler", async () => {
    const iosHandler = vi.fn().mockResolvedValue("from-ios");
    const androidHandler = vi.fn().mockResolvedValue("from-android");

    const execute = dispatchByPlatform<Record<string, never>, { udid: string }, string>({
      toolId: "test",
      capability: capabilityBoth,
      ios: { handler: iosHandler },
      android: { handler: androidHandler },
    });

    expect(await execute({}, { udid: iosUdid })).toBe("from-ios");
    expect(iosHandler).toHaveBeenCalledOnce();
    expect(androidHandler).not.toHaveBeenCalled();

    expect(await execute({}, { udid: androidUdid })).toBe("from-android");
    expect(androidHandler).toHaveBeenCalledOnce();
  });

  it("rejects with UnsupportedOperationError when capability does not declare the platform", async () => {
    const execute = dispatchByPlatform<Record<string, never>, { udid: string }, string>({
      toolId: "ios-only-tool",
      capability: capabilityIosOnly,
      ios: { handler: async () => "ok" },
      android: { handler: async () => "should-not-run" },
    });

    await expect(execute({}, { udid: androidUdid })).rejects.toBeInstanceOf(
      UnsupportedOperationError
    );
  });

  it("only checks the resolved branch's `requires` — iOS-only env doesn't trip the adb probe", async () => {
    // Cache says xcrun is present; adb is NOT primed → would fail an adb probe.
    __primeDepCacheForTests(["xcrun"]);

    const iosHandler = vi.fn().mockResolvedValue("ios-ran");
    const androidHandler = vi.fn().mockResolvedValue("android-ran");

    const execute = dispatchByPlatform<Record<string, never>, { udid: string }, string>({
      toolId: "test",
      capability: capabilityBoth,
      ios: { requires: ["xcrun"], handler: iosHandler },
      android: { requires: ["adb"], handler: androidHandler },
    });

    // iOS path: only xcrun is probed (already cached as available) — succeeds
    // even though adb is not present.
    expect(await execute({}, { udid: iosUdid })).toBe("ios-ran");
  });

  it("forwards services and InvokeToolOptions through to the handler", async () => {
    const handler = vi.fn(async (services, params, _device, options) => {
      return { sawSignal: !!options?.signal, sawService: services.foo };
    });

    const execute = dispatchByPlatform<{ foo: string }, { udid: string }, unknown>({
      toolId: "test",
      capability: capabilityBoth,
      ios: { handler },
      android: { handler },
    });

    const controller = new AbortController();
    const result = await execute({ foo: "bar" }, { udid: iosUdid }, { signal: controller.signal });
    expect(result).toEqual({ sawSignal: true, sawService: "bar" });
  });

  it("does not call ensureDeps when `requires` is undefined or empty", async () => {
    const handler = vi.fn().mockResolvedValue("ok");

    const noRequires: PlatformImpl<Record<string, never>, { udid: string }, string> = { handler };
    const emptyRequires: PlatformImpl<Record<string, never>, { udid: string }, string> = {
      requires: [],
      handler,
    };

    const a = dispatchByPlatform<Record<string, never>, { udid: string }, string>({
      toolId: "t",
      capability: capabilityBoth,
      ios: noRequires,
      android: emptyRequires,
    });

    // No primed cache, no ensureDeps probe — these would fail if ensureDeps fired.
    await expect(a({}, { udid: iosUdid })).resolves.toBe("ok");
    await expect(a({}, { udid: androidUdid })).resolves.toBe("ok");
  });
});
