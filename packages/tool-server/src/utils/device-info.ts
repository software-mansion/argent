import type { DeviceInfo, DeviceKind, Platform } from "@argent/registry";

/**
 * iOS simulator UDID format: 8-4-4-4-12 hex with dashes. Chromium devices use the
 * `chromium-cdp-<port>` prefix so they can be told apart from both iOS UUIDs and
 * Android adb serials by shape alone. Anything else is treated as an Android
 * serial. Classification is shape-based because `xcrun simctl list` and
 * `adb devices` are slow enough that listing on every hot tool call would
 * dominate its latency.
 */
const IOS_UDID_SHAPE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export const CHROMIUM_ID_PREFIX = "chromium-cdp-";

/** Returns the platform a `udid` belongs to based on its shape. */
export function classifyDevice(udid: string): Platform {
  if (udid.startsWith(CHROMIUM_ID_PREFIX)) return "chromium";
  return IOS_UDID_SHAPE.test(udid) ? "ios" : "android";
}

/**
 * Build a `DeviceInfo` from a raw udid. Fills the platform and a default kind
 * ('simulator' for iOS, 'emulator' for Android, 'app' for Chromium) — platform
 * impls can enrich with name/state/sdkLevel via simctl/adb if needed.
 */
export function resolveDevice(udid: string): DeviceInfo {
  const platform = classifyDevice(udid);
  const kind: DeviceKind =
    platform === "ios" ? "simulator" : platform === "android" ? "emulator" : "app";
  return { id: udid, platform, kind };
}

/** Parses the CDP port out of an chromium device id. Returns null if the id is malformed. */
export function parseChromiumCdpPort(udid: string): number | null {
  if (!udid.startsWith(CHROMIUM_ID_PREFIX)) return null;
  const tail = udid.slice(CHROMIUM_ID_PREFIX.length);
  if (!/^\d+$/.test(tail)) return null;
  const port = Number.parseInt(tail, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return port;
}

/** Build the canonical chromium device id from a CDP port. */
export function chromiumIdFromPort(port: number): string {
  return `${CHROMIUM_ID_PREFIX}${port}`;
}
