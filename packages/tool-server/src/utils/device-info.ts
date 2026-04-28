import type { DeviceInfo, DeviceKind, Platform } from "@argent/registry";

/**
 * iOS simulator UDID format: 8-4-4-4-12 hex with dashes. Anything else is treated
 * as an Android adb serial. We rely on shape rather than listing devices because
 * `xcrun simctl list` and `adb devices` are slow enough that classifying a hot
 * tool call would dominate its latency. A future enhancement can fall back to
 * listing when shape is ambiguous.
 */
const IOS_UDID_SHAPE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** Returns the platform a `udid` belongs to based on its shape. */
export function classifyDevice(udid: string): Platform {
  return IOS_UDID_SHAPE.test(udid) ? "ios" : "android";
}

/**
 * Build a `DeviceInfo` from a raw udid. v1 fills the platform and a default
 * kind ('simulator' for iOS, 'emulator' for Android) — platform impls can
 * enrich with name/state/sdkLevel via simctl/adb if needed.
 */
export function resolveDevice(udid: string): DeviceInfo {
  const platform = classifyDevice(udid);
  const kind: DeviceKind = platform === "ios" ? "simulator" : "emulator";
  return { id: udid, platform, kind };
}
