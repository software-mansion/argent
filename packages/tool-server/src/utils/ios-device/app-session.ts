import { FAILURE_CODES, withFailureSignal } from "@argent/registry";

/**
 * Tracks the app under automation on each physical device.
 * launch-app records the bundle id. The entry survives runner respawn and is cleared when we kill the process.
 */
const currentAppByUdid = new Map<string, string>();

/**
 * System UI bundle ids that launch-app only registers. They are always running.
 * restart-app and reinstall-app reject these ids.
 */
const SESSION_ONLY_SYSTEM_UI_BUNDLE_IDS = new Set(["com.apple.springboard", "com.apple.Spotlight"]);

/** True for SpringBoard and Spotlight. Match is exact and case-sensitive. */
export function isSessionOnlySystemUi(bundleId: string): boolean {
  return SESSION_ONLY_SYSTEM_UI_BUNDLE_IDS.has(bundleId);
}

export function setCurrentIosDeviceApp(udid: string, bundleId: string): void {
  currentAppByUdid.set(udid, bundleId);
}

/**
 * Delete the current-app entry for a device.
 *
 * @param bundleId when set, delete only if it matches. When omitted, delete unconditionally.
 */
export function clearCurrentIosDeviceApp(udid: string, bundleId?: string): void {
  if (bundleId === undefined || currentAppByUdid.get(udid) === bundleId) {
    currentAppByUdid.delete(udid);
  }
}

/**
 * Return the current app under automation.
 * Throws if none is set.
 */
export function requireCurrentIosDeviceApp(udid: string): string {
  const bundleId = currentAppByUdid.get(udid);

  if (!bundleId) {
    throw withFailureSignal(
      new Error(
        "No app is under automation on this device. Launch the target app first with " +
          "launch-app (or restart-app) so interactions and describe have a target; " +
          "on physical iOS devices XCUITest interactions are app-scoped."
      ),
      {
        error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
        failure_stage: "ios_device_app_session",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  return bundleId;
}
