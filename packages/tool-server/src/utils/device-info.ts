import type { DeviceInfo, DeviceKind, Platform } from "@argent/registry";

/**
 * iOS simulator UDID format: 8-4-4-4-12 hex with dashes. Chromium devices use the
 * `chromium-cdp-<port>` prefix and Vega devices the `amazon-` prefix, so both are
 * told apart from iOS UUIDs and Android adb serials by shape alone. Anything else
 * is treated as an Android serial. Classification is shape-based because
 * `xcrun simctl list` and `adb devices` are slow enough that listing on every hot
 * tool call would dominate its latency.
 */
const IOS_UDID_SHAPE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Physical iPhone/iPad UDID shape on Apple silicon devices (A12+/iOS 17+):
 * an 8-hex ECID prefix, a single dash, then 16 hex — e.g.
 * `00008120-000E6D0C0ABBA01E`. This is distinct from the simulator UUID
 * (four dashes) so a real device can be told apart from a simulator by shape
 * alone, the same way Android emulators vs phones are distinguished. Older
 * 40-hex device UDIDs belong to pre-A12 hardware outside the iOS 17+ full-parity
 * target for this backend, so they are intentionally not matched.
 */
const IOS_PHYSICAL_UDID_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/;

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

export const CHROMIUM_ID_PREFIX = "chromium-cdp-";

/** Whether a udid is a physical iOS device (vs a simulator UUID), by shape. */
export function isPhysicalIosUdid(udid: string): boolean {
  return IOS_PHYSICAL_UDID_SHAPE.test(udid);
}

/**
 * Vega serial prefix. `vega device list` reports VVD / Fire-TV serials as
 * `amazon-<id>` (e.g. `amazon-4a27df03c9777152`). No *known* Android adb serial
 * (`emulator-<port>`, a hardware serial, or `ip:port`) starts with it, so the
 * prefix classifies Vega by shape — the same approach as Chromium above. This is
 * a practical heuristic, not a guarantee: `ro.serialno` is vendor-defined and not
 * constrained by adb, so an Android device whose serial happened to start with
 * `amazon-` would be misrouted to the Vega paths (no shipping device is known to
 * collide). v1 supports the Virtual Device only, so a Vega serial resolves to
 * kind `vvd`.
 */
export const VEGA_SERIAL_PREFIX = "amazon-";

/** Returns the platform a `udid` belongs to based on its shape. */
export function classifyDevice(udid: string): Platform {
  if (udid.startsWith(REMOTE_PREFIX)) return "ios-remote";
  if (udid.startsWith(VEGA_SERIAL_PREFIX)) return "vega";
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
 * Build a `DeviceInfo` from a raw udid, by shape. Kind defaults per platform:
 * 'simulator' for an iOS simulator or ios-remote ('device' for a physical
 * iPhone/iPad by UDID shape), 'vvd' for Vega, 'emulator'/'device' for Android
 * by serial shape, 'app' for Chromium — platform impls can enrich with
 * name/state/sdkLevel via simctl/adb/sim-remote if needed.
 *
 * Vega is VVD-only in v1: the tool-server does not connect to or detect physical
 * Fire TV hardware, so every `amazon-` serial resolves to kind `vvd` by shape. A
 * physical device is therefore out of scope here — it is *not* classified as
 * `device` and so is *not* rejected by the capability gate (`vega: { vvd: true }`).
 * Supporting and gating real hardware is deferred to a version where it can
 * actually be tested; this code makes no assumptions about how one presents.
 */
export function resolveDevice(udid: string): DeviceInfo {
  const platform = classifyDevice(udid);
  const kind: DeviceKind =
    platform === "ios"
      ? isPhysicalIosUdid(udid)
        ? "device"
        : "simulator"
      : platform === "ios-remote"
        ? "simulator"
        : platform === "vega"
          ? "vvd"
          : platform === "android"
            ? isAndroidEmulatorSerial(udid)
              ? "emulator"
              : "device"
            : "app";
  return { id: udid, platform, kind };
}

/** A physical iOS device (driven via WebDriverAgent/XCTest, not simulator-server). */
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
