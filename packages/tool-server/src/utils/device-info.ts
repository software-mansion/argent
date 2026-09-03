import type { DeviceInfo, DeviceKind, Platform } from "@argent/registry";

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
export const REMOTE_PREFIX = "remote:";

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
export const VEGA_SERIAL_PREFIX = "amazon-";

export function classifyDevice(udid: string): Platform {
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

/** The mDNS services adb tracks for wireless debugging. adb names a device it
 * discovered that way by its service instance, so the serial carries no address
 * at all. Only `adb-tls-connect` is auto-connected by default, but
 * `$ADB_MDNS_AUTO_CONNECT` takes any of them and a serial from any is a device
 * reached over the network. */
const ADB_WIRELESS_MDNS_SERVICES = ["_adb._tcp", "_adb-tls-connect._tcp", "_adb-tls-pairing._tcp"];

/** A serial on one of these hosts is a forwarded port — docker-android, a
 * tunnelled CI emulator — not a radio link. The whole 127.0.0.0/8 block is
 * loopback too (`adb connect 127.0.0.2:5555`), so it is matched separately. */
const LOOPBACK_ADB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackAdbHost(host: string): boolean {
  const lower = host.toLowerCase();
  return LOOPBACK_ADB_HOSTS.has(lower) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower);
}

/**
 * True when adb reaches this device over the device's own Wi-Fi, so switching
 * that Wi-Fi off severs the transport carrying the command.
 *
 * Two serial forms say so. `adb connect <host>:<port>` gives `host:port` — USB
 * hardware serials and `emulator-<port>` carry no port, so the same test
 * excludes them. A device adb found over mDNS is listed under its service
 * instance instead, `adb-<serial>-<suffix>._adb-tls-connect._tcp`, with no
 * address at all.
 *
 * A host-only VM network (Genymotion, Waydroid) is indistinguishable from a LAN
 * address, so those are treated as wireless too — the conservative direction,
 * since the caller is told to use a different connection rather than losing one.
 */
export function isWirelessAdbSerial(serial: string): boolean {
  if (ADB_WIRELESS_MDNS_SERVICES.some((service) => serial.includes(service))) return true;
  const host = /^(.+):\d+$/.exec(serial)?.[1];
  return host !== undefined && !isLoopbackAdbHost(host);
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
  const kind: DeviceKind =
    platform === "ios" || platform === "ios-remote"
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
