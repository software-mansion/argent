import { describe, it, expect } from "vitest";
import {
  assertSupported,
  NotImplementedOnPlatformError,
  UnsupportedOperationError,
} from "../src/utils/capability";
import type { DeviceInfo, ToolCapability } from "@argent/registry";
import { CAPTURE_CAPABILITY } from "../src/tools/network/network-capture";

const iosSim: DeviceInfo = { id: "x", platform: "ios", kind: "simulator" };
const androidEmu: DeviceInfo = { id: "y", platform: "android", kind: "emulator" };

describe("assertSupported", () => {
  it("passes through when capability is undefined (no declaration)", () => {
    expect(() => assertSupported("t", undefined, iosSim)).not.toThrow();
    expect(() => assertSupported("t", undefined, androidEmu)).not.toThrow();
  });

  it("rejects a platform with no block declared", () => {
    const cap: ToolCapability = { apple: { simulator: true, device: true } };
    expect(() => assertSupported("t", cap, androidEmu)).toThrow(UnsupportedOperationError);
  });

  it("rejects a kind not enabled in the platform block", () => {
    const cap: ToolCapability = { apple: { simulator: true } };
    const iosDevice: DeviceInfo = { id: "x", platform: "ios", kind: "device" };
    expect(() => assertSupported("t", cap, iosDevice)).toThrow(UnsupportedOperationError);
  });

  it("respects the supports() refiner", () => {
    const cap: ToolCapability = {
      apple: { simulator: true },
      supports: (d) => d.id !== "x",
    };
    expect(() => assertSupported("t", cap, iosSim)).toThrow(UnsupportedOperationError);
  });

  it("passes when platform + kind + supports() all match", () => {
    const cap: ToolCapability = {
      apple: { simulator: true },
      android: { emulator: true },
    };
    expect(() => assertSupported("t", cap, iosSim)).not.toThrow();
    expect(() => assertSupported("t", cap, androidEmu)).not.toThrow();
  });

  it.each(["network-capture-start", "network-capture-stop"])(
    "says that %s is not needed on Vega, and names view-network-logs",
    (id) => {
      const vega: DeviceInfo = { id: "amazon-1", platform: "vega", kind: "vvd" };

      expect(() => assertSupported(id, CAPTURE_CAPABILITY, vega)).toThrow(
        `Tool '${id}' is not supported on vega vvd (a Vega app's network capture has no start or stop: view-network-logs turns it on at its first call).`
      );
    }
  );

  it.each(["network-capture-start", "network-capture-stop"])(
    "lets %s run on a Chromium app, whose one layer a start marks",
    (id) => {
      const chromium: DeviceInfo = { id: "chromium-cdp-9222", platform: "chromium", kind: "app" };

      expect(() => assertSupported(id, CAPTURE_CAPABILITY, chromium)).not.toThrow();
    }
  );

  it("gives the capture tools the stock reason on Chromium when a capability declares no Chromium block", () => {
    const chromium: DeviceInfo = { id: "chromium-cdp-9222", platform: "chromium", kind: "app" };
    const noChromium: ToolCapability = { apple: { simulator: true } };

    expect(() => assertSupported("network-capture-start", noChromium, chromium)).toThrow(
      "Tool 'network-capture-start' is not supported on chromium app (no chromium support declared)."
    );
  });

  it("gives another tool with no Vega block the stock reason there, not the capture one", () => {
    const vega: DeviceInfo = { id: "amazon-1", platform: "vega", kind: "vvd" };

    expect(() => assertSupported("reinstall-app", CAPTURE_CAPABILITY, vega)).toThrow(
      "Tool 'reinstall-app' is not supported on vega vvd (no vega support declared)."
    );
  });
});

describe("NotImplementedOnPlatformError", () => {
  it("composes a uniform message with toolId, platform, and the file path to fill in", () => {
    const err = new NotImplementedOnPlatformError({
      toolId: "demo-tool",
      platform: "android",
      hint: "Use `adb shell <command>`.",
    });
    expect(err.name).toBe("NotImplementedOnPlatformError");
    expect(err.toolId).toBe("demo-tool");
    expect(err.platform).toBe("android");
    expect(err.hint).toBe("Use `adb shell <command>`.");
    // The whole sentence: "demo-tool" and "android" on their own are substrings of the
    // path asserted below, so they hold for a message carrying no prose naming either.
    expect(err.message).toContain("Tool 'demo-tool' is not yet implemented on android.");
    expect(err.message).toContain("tools/demo-tool/platforms/android.ts");
    expect(err.message).toContain("capability declaration");
    expect(err.message).toContain("Use `adb shell");
  });

  it("works without a hint", () => {
    const err = new NotImplementedOnPlatformError({
      toolId: "demo-tool",
      platform: "android",
    });
    expect(err.hint).toBeNull();
    expect(err.message).toContain("demo-tool");
    expect(err.message).toContain("android");
  });
});
