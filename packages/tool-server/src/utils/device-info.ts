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

/**
 * Physical iPhone/iPad UDID shape on Apple silicon devices (A12+/iOS 17+):
 * an 8-hex ECID prefix, a single dash, then 16 hex — e.g.
 * `00008120-000E6D0C0ABBA01E`. This is distinct from the simulator UUID
 * (four dashes) so a real device can be told apart from a simulator by shape
 * alone, the same way Android emulators vs phones are distinguished. Older
 * 40-hex device UDIDs belong to pre-A12 hardware that tops out well below the
 * iOS 27 floor for the CoreDevice control path, so they are intentionally not matched.
 */
const IOS_PHYSICAL_UDID_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/;

export const CHROMIUM_ID_PREFIX = "chromium-cdp-";

/** Whether a udid is a physical iOS device (vs a simulator UUID), by shape. */
export function isPhysicalIosUdid(udid: string): boolean {
  return IOS_PHYSICAL_UDID_SHAPE.test(udid);
}

/** Returns the platform a `udid` belongs to based on its shape. */
export function classifyDevice(udid: string): Platform {
  if (udid.startsWith(CHROMIUM_ID_PREFIX)) return "chromium";
  if (IOS_UDID_SHAPE.test(udid) || IOS_PHYSICAL_UDID_SHAPE.test(udid)) return "ios";
  return "android";
}

/**
 * Distinguish a physical Android phone from an emulator by serial shape. Local
 * emulators always register with adb as `emulator-<port>` (set by the emulator
 * itself), so any other Android serial — a USB device's hardware serial, or an
 * `ip:port` from wireless debugging — is a physical device. This mirrors how
 * radon detects connected phones (it filters the `emulator-` prefix out of
 * `adb devices`) and, like the rest of this module, stays purely shape-based so
 * it adds no `adb` round-trip on the hot path.
 *
 * The distinction matters because the two are driven by different
 * simulator-server controllers: emulators stream decoded RGB over the emulator
 * gRPC bridge (`android` subcommand), while physical devices run the
 * screen-sharing agent and stream H264 over adb (`android_device` subcommand).
 */
export function isAndroidEmulatorSerial(serial: string): boolean {
  return serial.startsWith("emulator-");
}

/**
 * Build a `DeviceInfo` from a raw udid. Fills the platform and a default kind
 * ('simulator' for iOS, 'emulator'/'device' for Android by serial shape, 'app'
 * for Chromium) — platform impls can enrich with name/state/sdkLevel via
 * simctl/adb if needed.
 */
export function resolveDevice(udid: string): DeviceInfo {
  const platform = classifyDevice(udid);
  const kind: DeviceKind =
    platform === "ios"
      ? isPhysicalIosUdid(udid)
        ? "device"
        : "simulator"
      : platform === "android"
        ? isAndroidEmulatorSerial(udid)
          ? "emulator"
          : "device"
        : "app";
  return { id: udid, platform, kind };
}

/** A physical iOS device (driven via CoreDevice/pymobiledevice3, not the simulator-server). */
export function isPhysicalIos(device: DeviceInfo): boolean {
  return device.platform === "ios" && device.kind === "device";
}

/** Parses the CDP port out of a chromium device id. Returns null if the id is malformed. */
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
