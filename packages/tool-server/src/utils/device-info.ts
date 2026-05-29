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

/**
 * Prefix used on device ids that route through `sim-remote` to a remote iOS
 * simulator. The raw UUID after the prefix is the same RFC-4122 shape as a
 * local iOS UDID — the prefix is the only thing that disambiguates a remote
 * sim from a local one.
 */
export const REMOTE_PREFIX = "remote:";

/** Strip the `remote:` prefix from a device id, returning the bare UDID. */
export function stripRemotePrefix(id: string): string {
  return id.startsWith(REMOTE_PREFIX) ? id.slice(REMOTE_PREFIX.length) : id;
}

/** Wrap a bare UDID with the `remote:` prefix used by the ios-remote platform. */
export function withRemotePrefix(udid: string): string {
  return udid.startsWith(REMOTE_PREFIX) ? udid : `${REMOTE_PREFIX}${udid}`;
}

/** Returns the platform a `udid` belongs to based on its shape. */
export function classifyDevice(udid: string): Platform {
  if (udid.startsWith(REMOTE_PREFIX)) return "ios-remote";
  return IOS_UDID_SHAPE.test(udid) ? "ios" : "android";
}

/**
 * Build a `DeviceInfo` from a raw udid. v1 fills the platform and a default
 * kind ('simulator' for iOS / ios-remote, 'emulator' for Android) — platform
 * impls can enrich with name/state/sdkLevel via simctl/adb/sim-remote as needed.
 */
export function resolveDevice(udid: string): DeviceInfo {
  const platform = classifyDevice(udid);
  const kind: DeviceKind = platform === "android" ? "emulator" : "simulator";
  return { id: udid, platform, kind };
}
