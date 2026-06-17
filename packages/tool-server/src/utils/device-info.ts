import type { DeviceInfo, DeviceKind, Platform } from "@argent/registry";

/**
 * iOS simulator UDID format: 8-4-4-4-12 hex with dashes. Chromium devices use the
 * `chromium-cdp-<port>` prefix so they can be told apart from both iOS UUIDs and
 * Android adb serials by shape alone. Vega devices are registered in an inventory.
 * Anything else is treated as an Android serial. Classification is shape-based because
 * `xcrun simctl list` and `adb devices` are slow enough that listing on every hot
 * tool call would dominate its latency.
 */
const IOS_UDID_SHAPE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export const CHROMIUM_ID_PREFIX = "chromium-cdp-";

/**
 * Vega device inventory. Unlike iOS/Android, a Vega serial (e.g.
 * `amazon-4a27df03c9777152`) has no shape that distinguishes it from an Android
 * adb serial, so `classifyDevice` cannot guess it. Instead, Vega discovery
 * (`listVegaDevices`) registers what it found here, and `resolveDevice` consults
 * this map first. The Vega watcher keeps it warm in the running server; tests
 * and one-shot harnesses populate it by calling `list-devices` (or discovery)
 * before any device-targeting Vega tool.
 */
export interface VegaInventoryEntry {
  kind: DeviceKind;
  name?: string;
  state?: string;
}
const vegaInventory = new Map<string, VegaInventoryEntry>();

/**
 * Replace the known set of Vega devices wholesale. Wholesale (not merge) so a
 * device that has since stopped/disconnected stops resolving as Vega instead of
 * lingering forever.
 */
export function registerVegaDevices(entries: Array<{ id: string } & VegaInventoryEntry>): void {
  vegaInventory.clear();
  for (const e of entries) {
    vegaInventory.set(e.id, { kind: e.kind, name: e.name, state: e.state });
  }
}

/** Test-only: clear the Vega inventory between tests. */
export function __resetVegaInventoryForTests(): void {
  vegaInventory.clear();
}

/** Returns the platform a `udid` belongs to based on its shape. Known Vega serials win over shape. */
export function classifyDevice(udid: string): Platform {
  if (vegaInventory.has(udid)) return "vega";
  if (udid.startsWith(CHROMIUM_ID_PREFIX)) return "chromium";
  return IOS_UDID_SHAPE.test(udid) ? "ios" : "android";
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
 * Build a `DeviceInfo` from a raw udid. Vega devices are resolved from the
 * inventory (carrying their discovered kind/name/state); iOS/Android fill the
 * platform and a default kind ('simulator' for iOS, 'emulator'/'device' for Android
 * by serial shape, 'app' for Chromium) — platform impls can enrich with name/state/sdkLevel
 * via simctl/adb if needed.
 */
export function resolveDevice(udid: string): DeviceInfo {
  const vega = vegaInventory.get(udid);
  if (vega) {
    return { id: udid, platform: "vega", kind: vega.kind, name: vega.name, state: vega.state };
  }
  const platform = classifyDevice(udid);
  const kind: DeviceKind =
    platform === "ios"
      ? "simulator"
      : platform === "android"
        ? isAndroidEmulatorSerial(udid)
          ? "emulator"
          : "device"
        : "app";
  return { id: udid, platform, kind };
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
