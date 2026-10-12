import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureDeviceReady = vi.fn();
const uninstallApp = vi.fn();
const installApp = vi.fn();
vi.mock("../src/utils/ios-device/devicectl", () => ({
  ensureDeviceReady: (...a: unknown[]) => ensureDeviceReady(...a),
  uninstallApp: (...a: unknown[]) => uninstallApp(...a),
  installApp: (...a: unknown[]) => installApp(...a),
}));

import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
import { iosDeviceImpl } from "../src/tools/reinstall-app/platforms/ios-device";
import type { ReinstallAppParams, ReinstallAppServices } from "../src/tools/reinstall-app/types";
import {
  clearCurrentIosDeviceApp,
  requireCurrentIosDeviceApp,
  setCurrentIosDeviceApp,
} from "../src/utils/ios-device/app-session";

const UDID = "00008110-000978540290401E";
const BUNDLE = "com.example.app";

const SERVICES: ReinstallAppServices = {};
const PARAMS: ReinstallAppParams = { udid: UDID, bundleId: BUNDLE, appPath: "/tmp/App.app" };
// The handler ignores device/options; a stub satisfies the (services, params, device) arity.
const DEVICE = { platform: "ios", kind: "device", udid: UDID } as unknown as DeviceInfo;

beforeEach(() => {
  ensureDeviceReady.mockReset().mockResolvedValue(undefined);
  uninstallApp.mockReset().mockResolvedValue(undefined);
  installApp.mockReset().mockResolvedValue(undefined);
  clearCurrentIosDeviceApp(UDID);
});

describe("ios-device reinstall: app-session invalidation", () => {
  it("clears the session, so the next app-scoped command demands a fresh launch", async () => {
    setCurrentIosDeviceApp(UDID, BUNDLE);
    await expect(iosDeviceImpl.handler(SERVICES, PARAMS, DEVICE)).resolves.toMatchObject({
      reinstalled: true,
    });
    expect(() => requireCurrentIosDeviceApp(UDID)).toThrow(/Launch the target app first/);
  });

  it("leaves a session naming a different bundle untouched", async () => {
    setCurrentIosDeviceApp(UDID, "com.other.app");
    await iosDeviceImpl.handler(SERVICES, PARAMS, DEVICE);
    expect(requireCurrentIosDeviceApp(UDID)).toBe("com.other.app");
  });

  it("clears even when the install fails: the uninstall already killed the process", async () => {
    setCurrentIosDeviceApp(UDID, BUNDLE);
    installApp.mockRejectedValue(new Error("install failed"));
    await expect(iosDeviceImpl.handler(SERVICES, PARAMS, DEVICE)).rejects.toThrow(/install failed/);
    expect(() => requireCurrentIosDeviceApp(UDID)).toThrow(/Launch the target app first/);
  });

  it("keeps the session when the uninstall itself fails: nothing was killed", async () => {
    setCurrentIosDeviceApp(UDID, BUNDLE);
    uninstallApp.mockRejectedValue(new Error("uninstall failed"));
    await expect(iosDeviceImpl.handler(SERVICES, PARAMS, DEVICE)).rejects.toThrow(
      /uninstall failed/
    );
    expect(requireCurrentIosDeviceApp(UDID)).toBe(BUNDLE);
  });

  it("stamps the no-app-under-automation rejection with a failure signal", () => {
    let caught: unknown;
    try {
      requireCurrentIosDeviceApp(UDID);
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain("No app is under automation");
    // Telemetry classification (T44): the launch-the-app-first rejection must
    // not fall into the registry's unclassified bucket.
    const signal = getFailureSignal(caught);
    expect(signal?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(signal?.failure_stage).toBe("ios_device_app_session");
  });
});
