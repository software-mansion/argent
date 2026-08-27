import type { DeviceInfo, DeviceKind, Platform } from "@argent/registry";
import { EXTERNAL_PREFIX, externalNativeId } from "./external-devices";

/**
 * iOS simulator UDID shape: 8-4-4-4-12 hex. Everything here classifies by shape
 * because `xcrun simctl list` and `adb devices` are slow enough that listing on
 * every hot tool call would dominate its latency.
 */
const IOS_UDID_SHAPE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Prefix on device ids that route through `sim-remote` to a remote iOS
 * simulator. The UUID after it has the same shape as a local iOS UDID, so the
 * prefix is the only thing telling the two apart.
 */
const REMOTE_PREFIX = "remote:";

export function stripRemotePrefix(id: string): string {
  return id.startsWith(REMOTE_PREFIX) ? id.slice(REMOTE_PREFIX.length) : id;
}

export function withRemotePrefix(udid: string): string {
  return udid.startsWith(REMOTE_PREFIX) ? udid : `${REMOTE_PREFIX}${udid}`;
}

export const CHROMIUM_ID_PREFIX = "chromium-cdp-";

/**
 * `vega device list` reports VVD / Fire-TV serials as `amazon-<id>` (e.g.
 * `amazon-4a27df03c9777152`). No known Android adb serial starts with it, but
 * `ro.serialno` is vendor-defined, so a colliding Android serial would be
 * misrouted to the Vega paths.
 */
const VEGA_SERIAL_PREFIX = "amazon-";

export function classifyDevice(udid: string): Platform {
  /**
   * An `ext:<providerId>:<nativeId>` device classifies by its NATIVE id's
   * shape. The prefix carries no platform information on purpose, so there is
   * one set of classification rules, not a second for attached devices. A
   * malformed `ext:` id yields itself back, and falling through rather than
   * recursing is what stops `"ext:"` looping forever.
   */
  if (udid.startsWith(EXTERNAL_PREFIX)) {
    const nativeId = externalNativeId(udid);
    if (nativeId !== udid) return classifyDevice(nativeId);
  }

  if (udid.startsWith(REMOTE_PREFIX)) return "ios-remote";
  if (udid.startsWith(VEGA_SERIAL_PREFIX)) return "vega";
  if (udid.startsWith(CHROMIUM_ID_PREFIX)) return "chromium";
  return IOS_UDID_SHAPE.test(udid) ? "ios" : "android";
}

/**
 * Local emulators always register with adb as `emulator-<port>`, so any other
 * Android serial — a USB hardware serial, or an `ip:port` from wireless
 * debugging — is a physical device.
 *
 * The distinction picks the simulator-server controller: emulators go through
 * the emulator gRPC bridge (`android` subcommand), physical devices through the
 * screen-sharing agent over adb (`android_device`).
 */
export function isAndroidEmulatorSerial(serial: string): boolean {
  return serial.startsWith("emulator-");
}

/**
 * Kind is defaulted by shape; platform impls can enrich the result with
 * name/state/sdkLevel from simctl/adb/sim-remote.
 *
 * Vega is VVD-only: the tool-server neither connects to nor detects physical
 * Fire TV hardware, so every `amazon-` serial resolves to kind `vvd` and never
 * hits the `device` rejection in the `vega: { vvd: true }` capability gate.
 */
export function resolveDevice(udid: string): DeviceInfo {
  const platform = classifyDevice(udid);
  /**
   * Kind derives from the native id too, so a prefixed `emulator-5554` still
   * reads as an emulator rather than a physical phone. Identity for other ids.
   */
  const shapeId = externalNativeId(udid);
  const kind: DeviceKind =
    platform === "ios" || platform === "ios-remote"
      ? "simulator"
      : platform === "vega"
        ? "vvd"
        : platform === "android"
          ? isAndroidEmulatorSerial(shapeId)
            ? "emulator"
            : "device"
          : "app";
  return { id: udid, platform, kind };
}

export function parseChromiumCdpPort(udid: string): number | null {
  if (!udid.startsWith(CHROMIUM_ID_PREFIX)) return null;
  const tail = udid.slice(CHROMIUM_ID_PREFIX.length);
  if (!/^\d+$/.test(tail)) return null;
  const port = Number.parseInt(tail, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return port;
}

export function chromiumIdFromPort(port: number): string {
  return `${CHROMIUM_ID_PREFIX}${port}`;
}
