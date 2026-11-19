import { describe, it, expect, beforeEach, vi } from "vitest";

const findIosSimulator = vi.fn();
const adbShell = vi.fn();

vi.mock("../../src/utils/ios-devices", () => ({ findIosSimulator }));
vi.mock("../../src/utils/adb", () => ({ adbShell }));

const { deviceNameMatcher } = await import("../../src/utils/debugger/device-name");

const SIM_UDID = "B7D5711C-0000-4000-8000-000000000000";

describe("deviceNameMatcher", () => {
  beforeEach(() => {
    findIosSimulator.mockReset();
    adbShell.mockReset();
  });

  it("matches an iOS simulator by its exact name", async () => {
    findIosSimulator.mockResolvedValue({ udid: SIM_UDID, name: "iPhone 17 [ink-and-quill]" });
    const matches = await deviceNameMatcher(SIM_UDID);
    expect(matches?.("iPhone 17 [ink-and-quill]")).toBe(true);
    expect(matches?.("iPhone 17")).toBe(false);
  });

  it("gives no matcher for a simulator it cannot find", async () => {
    findIosSimulator.mockResolvedValue(undefined);
    expect(await deviceNameMatcher(SIM_UDID)).toBeUndefined();
  });

  it("matches an Android device by model, with or without the release suffix", async () => {
    adbShell.mockResolvedValue("sdk_gphone64_arm64\n");
    const matches = await deviceNameMatcher("emulator-5554");
    expect(adbShell).toHaveBeenCalledWith("emulator-5554", "getprop ro.product.model", {
      timeoutMs: 5_000,
    });
    expect(matches?.("sdk_gphone64_arm64 - 16 - API 36")).toBe(true);
    expect(matches?.("sdk_gphone64_arm64")).toBe(true);
    expect(matches?.("sdk_gphone64_arm64_v2 - 16 - API 36")).toBe(false);
  });

  it("gives no matcher when adb fails", async () => {
    adbShell.mockRejectedValue(new Error("device offline"));
    expect(await deviceNameMatcher("emulator-5554")).toBeUndefined();
  });

  it("gives no matcher for ids that carry no usable name", async () => {
    expect(await deviceNameMatcher("chromium-cdp-9222")).toBeUndefined();
    expect(await deviceNameMatcher("00008110-001A2B3C4D5E801E")).toBeUndefined();
    expect(findIosSimulator).not.toHaveBeenCalled();
    expect(adbShell).not.toHaveBeenCalled();
  });
});
