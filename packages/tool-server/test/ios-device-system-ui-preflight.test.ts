import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the devicectl seam so the handlers run without hardware; the app-session
// module stays real: its predicate and map are the state under test. The
// pre-flight must reject system-UI bundle ids BEFORE any of these are called.
const ensureDeviceReady = vi.fn();
const launchApp = vi.fn();
const uninstallApp = vi.fn();
const installApp = vi.fn();
vi.mock("../src/utils/ios-device/devicectl", () => ({
  ensureDeviceReady: (...a: unknown[]) => ensureDeviceReady(...a),
  launchApp: (...a: unknown[]) => launchApp(...a),
  uninstallApp: (...a: unknown[]) => uninstallApp(...a),
  installApp: (...a: unknown[]) => installApp(...a),
}));

// launch-app's post-launch signing probe; mocked so no test resolves signing
// for real (which would read the env var or the developer's keychain).
const resolveRunnerSigningConfig = vi.fn();
vi.mock("../src/utils/ios-device/runner-build", () => ({
  resolveRunnerSigningConfig: (...a: unknown[]) => resolveRunnerSigningConfig(...a),
}));

import type { DeviceInfo } from "@argent/registry";
import { iosDeviceImpl as launchImpl } from "../src/tools/launch-app/platforms/ios-device";
import { iosDeviceImpl as restartImpl } from "../src/tools/restart-app/platforms/ios-device";
import { iosDeviceImpl as reinstallImpl } from "../src/tools/reinstall-app/platforms/ios-device";
import { InvalidToolInputError } from "../src/utils/capability";
import {
  clearCurrentIosDeviceApp,
  isSessionOnlySystemUi,
  requireCurrentIosDeviceApp,
} from "../src/utils/ios-device/app-session";

// Physical-iOS UDID shape (8 hex, dash, 16 hex); see utils/device-info.ts.
const UDID = "00008110-000978540290401E";
const SPRINGBOARD = "com.apple.springboard";
const SPOTLIGHT = "com.apple.Spotlight";
// The handlers ignore device/options; a stub satisfies the (services, params, device) arity.
const DEVICE = { platform: "ios", kind: "device", udid: UDID } as unknown as DeviceInfo;

beforeEach(() => {
  ensureDeviceReady.mockReset().mockResolvedValue(undefined);
  launchApp.mockReset().mockResolvedValue(undefined);
  uninstallApp.mockReset().mockResolvedValue(undefined);
  installApp.mockReset().mockResolvedValue(undefined);
  // Signing resolves by default, so launch results stay note-free unless a
  // case rejects it on purpose.
  resolveRunnerSigningConfig.mockReset().mockResolvedValue({
    teamId: "ABCDE12345",
    appBundleId: "com.argent.runner.tabcde12345",
    testBundleId: "com.argent.runner.tabcde12345.uitests",
  });
  // The session map is module-level state; start every test without an entry.
  clearCurrentIosDeviceApp(UDID);
});

describe("isSessionOnlySystemUi", () => {
  it("matches exactly the two system-UI ids, case-sensitively", () => {
    expect(isSessionOnlySystemUi(SPRINGBOARD)).toBe(true);
    expect(isSessionOnlySystemUi(SPOTLIGHT)).toBe(true);
    expect(isSessionOnlySystemUi("com.example.app")).toBe(false);
    expect(isSessionOnlySystemUi("com.apple.Preferences")).toBe(false);
    // Case variants stay OUT: a normalizing lookup would silently widen the set.
    expect(isSessionOnlySystemUi("com.apple.SpringBoard")).toBe(false);
    expect(isSessionOnlySystemUi("com.apple.spotlight")).toBe(false);
  });
});

describe("restart-app (ios-device): system-UI pre-flight", () => {
  it.each([SPRINGBOARD, SPOTLIGHT])("rejects %s before any device contact", async (bundleId) => {
    const err = await restartImpl
      .handler({}, { udid: UDID, bundleId }, DEVICE)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect((err as Error).message).toBe(
      `${bundleId} is system UI: it is always running and cannot be restarted. ` +
        "Use launch-app to put it under automation."
    );
    expect(ensureDeviceReady).not.toHaveBeenCalled();
    expect(launchApp).not.toHaveBeenCalled();
    // The rejection also registers no session.
    expect(() => requireCurrentIosDeviceApp(UDID)).toThrow(/Launch the target app first/);
  });

  it("still restarts a regular app", async () => {
    await expect(
      restartImpl.handler({}, { udid: UDID, bundleId: "com.example.app" }, DEVICE)
    ).resolves.toEqual({ restarted: true, bundleId: "com.example.app" });
    expect(launchApp).toHaveBeenCalledWith(UDID, "com.example.app", { terminateExisting: true });
  });
});

describe("reinstall-app (ios-device): system-UI pre-flight", () => {
  it.each([SPRINGBOARD, SPOTLIGHT])("rejects %s before any device contact", async (bundleId) => {
    const err = await reinstallImpl
      .handler({}, { udid: UDID, bundleId, appPath: "/tmp/App.app" }, DEVICE)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect((err as Error).message).toBe(
      `${bundleId} is system UI: it is always running and cannot be reinstalled. ` +
        "Use launch-app to put it under automation."
    );
    expect(ensureDeviceReady).not.toHaveBeenCalled();
    expect(uninstallApp).not.toHaveBeenCalled();
    expect(installApp).not.toHaveBeenCalled();
  });
});

describe("launch-app (ios-device): session-only registration unchanged", () => {
  it.each([SPRINGBOARD, SPOTLIGHT])(
    "%s registers the session without a devicectl launch",
    async (bundleId) => {
      await expect(launchImpl.handler({}, { udid: UDID, bundleId }, DEVICE)).resolves.toEqual({
        launched: true,
        bundleId,
      });
      expect(ensureDeviceReady).toHaveBeenCalledWith(UDID);
      expect(launchApp).not.toHaveBeenCalled();
      expect(requireCurrentIosDeviceApp(UDID)).toBe(bundleId);
    }
  );

  it("a regular app still gets a devicectl launch", async () => {
    await expect(
      launchImpl.handler({}, { udid: UDID, bundleId: "com.example.app" }, DEVICE)
    ).resolves.toEqual({ launched: true, bundleId: "com.example.app" });
    expect(launchApp).toHaveBeenCalledWith(UDID, "com.example.app");
    expect(requireCurrentIosDeviceApp(UDID)).toBe("com.example.app");
  });
});

describe("launch-app (ios-device): signing readiness note", () => {
  // The `toEqual` cases above already pin the note-absent shape when signing
  // resolves; these cover the unready and the slow-probe outcomes.
  it("notes unready signing with the first sentence of the resolution error", async () => {
    resolveRunnerSigningConfig.mockRejectedValue(
      new Error(
        "No Apple Development signing certificate was found in this Mac's keychain, " +
          "so the on-device runner cannot be signed. Open Xcode > Settings > Accounts " +
          "and sign in with your Apple ID."
      )
    );

    const result = await launchImpl.handler(
      {},
      { udid: UDID, bundleId: "com.example.app" },
      DEVICE
    );

    expect(result).toEqual({
      launched: true,
      bundleId: "com.example.app",
      note:
        "Runner signing is not ready: No Apple Development signing certificate was " +
        "found in this Mac's keychain, so the on-device runner cannot be signed.",
    });
    // The launch itself already happened; the probe only annotates it.
    expect(launchApp).toHaveBeenCalledWith(UDID, "com.example.app");
  });

  it("keeps a periodless resolution failure whole instead of truncating it away", async () => {
    resolveRunnerSigningConfig.mockRejectedValue(new Error("keychain locked"));

    await expect(
      launchImpl.handler({}, { udid: UDID, bundleId: "com.example.app" }, DEVICE)
    ).resolves.toMatchObject({ note: "Runner signing is not ready: keychain locked" });
  });

  it("bounds a hanging probe: the launch result returns note-free after the timeout", async () => {
    // A first-probe `security` shellout on a wedged keychain can hang; the
    // note is best-effort and must never gate the launch result on it.
    resolveRunnerSigningConfig.mockImplementation(() => new Promise(() => {}));

    vi.useFakeTimers();
    try {
      const pending = launchImpl.handler({}, { udid: UDID, bundleId: "com.example.app" }, DEVICE);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(pending).resolves.toEqual({ launched: true, bundleId: "com.example.app" });
    } finally {
      vi.useRealTimers();
    }
  });
});
