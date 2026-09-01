import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureDeviceReady = vi.fn();
const launchApp = vi.fn();
vi.mock("../src/utils/ios-device/devicectl", () => ({
  ensureDeviceReady: (...a: unknown[]) => ensureDeviceReady(...a),
  launchApp: (...a: unknown[]) => launchApp(...a),
}));

import type { DeviceInfo } from "@argent/registry";
import { iosDeviceImpl } from "../src/tools/open-url/platforms/ios-device";
import {
  clearCurrentIosDeviceApp,
  requireCurrentIosDeviceApp,
} from "../src/utils/ios-device/app-session";

const UDID = "00008110-000978540290401E";
const SAFARI = "com.apple.mobilesafari";
// The handler ignores device/options; a stub satisfies the (services, params, device) arity.
const DEVICE = { platform: "ios", kind: "device", id: UDID } as unknown as DeviceInfo;

beforeEach(() => {
  ensureDeviceReady.mockReset().mockResolvedValue(undefined);
  launchApp.mockReset().mockResolvedValue(undefined);
  clearCurrentIosDeviceApp(UDID);
});

describe("ios-device open-url", () => {
  it("delivers an https URL to Safari by default and keeps the deep-link note", async () => {
    const res = await iosDeviceImpl.handler(
      {},
      { udid: UDID, url: "https://bsky.app/profile/x" },
      DEVICE
    );

    expect(launchApp).toHaveBeenCalledWith(UDID, SAFARI, {
      payloadUrl: "https://bsky.app/profile/x",
    });
    expect(res.opened).toBe(true);
    expect(res.url).toBe("https://bsky.app/profile/x");
    expect(res.note).toBeTypeOf("string");
    // The launch fronts Safari, so it becomes the app under automation.
    expect(requireCurrentIosDeviceApp(UDID)).toBe(SAFARI);
  });

  it("delivers a custom scheme to the named app and registers it, without the note", async () => {
    const res = await iosDeviceImpl.handler(
      {},
      { udid: UDID, url: "bluesky://profile/x", bundleId: "xyz.blueskyweb.app" },
      DEVICE
    );

    expect(launchApp).toHaveBeenCalledWith(UDID, "xyz.blueskyweb.app", {
      payloadUrl: "bluesky://profile/x",
    });
    expect(res.opened).toBe(true);
    expect(res.note).toBeUndefined();
    expect(requireCurrentIosDeviceApp(UDID)).toBe("xyz.blueskyweb.app");
  });

  it("omits the note when an https URL goes to an explicitly named app", async () => {
    const res = await iosDeviceImpl.handler(
      {},
      { udid: UDID, url: "https://bsky.app/profile/x", bundleId: "xyz.blueskyweb.app" },
      DEVICE
    );

    expect(res.note).toBeUndefined();
  });

  it("rejects a custom scheme without bundleId, naming the parameter and the alternative", async () => {
    const error = await iosDeviceImpl
      .handler({}, { udid: UDID, url: "bluesky://profile/x" }, DEVICE)
      .catch((caught: unknown) => caught);

    expect((error as Error).name).toBe("InvalidToolInputError");
    expect((error as Error).message).toContain("bundleId");
    expect((error as Error).message).toContain("launch-app");
    // Rejected before contacting the device, and no session was registered.
    expect(ensureDeviceReady).not.toHaveBeenCalled();
    expect(launchApp).not.toHaveBeenCalled();
    expect(() => requireCurrentIosDeviceApp(UDID)).toThrow(/Launch the target app first/);
  });

  it("rejects system UI as the receiver before contacting the device", async () => {
    const error = await iosDeviceImpl
      .handler(
        {},
        { udid: UDID, url: "x-web-search://query", bundleId: "com.apple.springboard" },
        DEVICE
      )
      .catch((caught: unknown) => caught);

    expect((error as Error).name).toBe("InvalidToolInputError");
    expect((error as Error).message).toContain("system UI");
    expect(ensureDeviceReady).not.toHaveBeenCalled();
    expect(launchApp).not.toHaveBeenCalled();
  });

  it("checks device readiness before launching", async () => {
    const order: string[] = [];
    ensureDeviceReady.mockImplementation(async () => order.push("ready"));
    launchApp.mockImplementation(async () => order.push("launch"));

    await iosDeviceImpl.handler({}, { udid: UDID, url: "https://example.com" }, DEVICE);

    expect(order).toEqual(["ready", "launch"]);
  });

  it("does not register a session when the launch fails", async () => {
    launchApp.mockRejectedValue(new Error("launch failed"));

    await expect(
      iosDeviceImpl.handler({}, { udid: UDID, url: "https://example.com" }, DEVICE)
    ).rejects.toThrow("launch failed");
    expect(() => requireCurrentIosDeviceApp(UDID)).toThrow(/Launch the target app first/);
  });
});
