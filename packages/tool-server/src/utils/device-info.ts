import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { DeviceInfo, DeviceKind, Platform } from "@argent/registry";

/**
 * iOS simulator UDID shape: 8-4-4-4-12 hex. Everything here classifies by shape
 * because `xcrun simctl list` and `adb devices` are slow enough that listing on
 * every hot tool call would dominate its latency.
 */
const IOS_UDID_SHAPE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Physical iOS device UDID format (A12/2018 hardware and newer): 8 hex digits,
 * a dash, then 16 hex digits (e.g. `00008110-000978540290401E`). Distinct from
 * both the simulator UUID shape and every known Android serial form, so it is
 * safe to classify by shape on the hot path. Legacy 40-hex UDIDs (A11 hardware
 * and older) are deliberately unsupported: 40 bare hex characters are
 * ambiguous with Android serials, so classifying them by shape here would
 * misroute a device. Age alone would not settle it - the A10 iPad 6th and 7th
 * generations carry a 40-hex UDID and do run iPadOS 17, the floor for the
 * CoreDevice (`devicectl`) tooling this backend is built on.
 */
const IOS_PHYSICAL_UDID_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/;

/** True when `udid` has the modern physical-iPhone UDID shape (see above). */
export function isIosPhysicalUdid(udid: string): boolean {
  return IOS_PHYSICAL_UDID_SHAPE.test(udid);
}

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

/**
 * HarmonyOS device-id prefix. Every HarmonyOS id carries it, so the platform is
 * decided by shape like the others — argent mints these ids rather than
 * receiving them, the same way `chromium-cdp-<port>` is argent's own.
 */
export const HARMONY_ID_PREFIX = "harmony-";

/**
 * Marks the ids that name an emulator *instance* rather than a connected target.
 *
 * The two are different things addressed by different CLIs: an instance is a
 * config directory that `Emulator -start` boots, a connected target is an `hdc`
 * connect key that `uitest` drives. They cannot be told apart by shape — an
 * instance name is user-chosen and could be spelled exactly like a hardware
 * serial — so the distinction is carried in the id itself, mirroring how a local
 * Android AVD is identifiable from its `emulator-<port>` serial.
 *
 * A running emulator therefore appears twice in `list-devices`: once as its
 * instance (bootable, stoppable) and once as whatever connect key it registered
 * with `hdc` (drivable). This is exactly what Android does with `avds` vs
 * `adb devices`, and for the same reason.
 */
export const HARMONY_EMULATOR_ID_PREFIX = "harmony-emulator-";

/** Build the `list-devices` id for an emulator instance. */
export function harmonyEmulatorId(instanceName: string): string {
  return `${HARMONY_EMULATOR_ID_PREFIX}${instanceName}`;
}

/** Build the `list-devices` id for a target `hdc` is connected to. */
export function harmonyDeviceId(connectKey: string): string {
  return `${HARMONY_ID_PREFIX}${connectKey}`;
}

/**
 * The emulator instance name behind a `harmony-emulator-<name>` id.
 *
 * Exactly one prefix is stripped, so an instance genuinely named `emulator-x`
 * round-trips through `harmonyEmulatorId` unharmed. A connect-key id keeps its
 * `harmony-` prefix rather than being read as an instance name, so handing a
 * phone's id to `boot-device` fails on an instance that does not exist instead
 * of silently starting whichever one happens to be named after a serial.
 */
export function harmonyInstanceName(udid: string): string {
  return udid.startsWith(HARMONY_EMULATOR_ID_PREFIX)
    ? udid.slice(HARMONY_EMULATOR_ID_PREFIX.length)
    : udid;
}

/**
 * The `hdc` connect key behind a `harmony-<connectKey>` id.
 *
 * An instance id is refused rather than stripped: `harmony-emulator-<name>`
 * carries the `harmony-` prefix too, so slicing it yields `emulator-<name>` — a
 * key no target holds, which `hdc` answers with `[Fail]Not match target` naming
 * a device the caller never asked for. The capability gate turns an instance id
 * away at the HTTP edge, but a flow step reaches `execute` through the registry,
 * which does not gate it.
 */
export function harmonyConnectKey(udid: string): string {
  if (udid.startsWith(HARMONY_EMULATOR_ID_PREFIX)) {
    throw new FailureError(
      `"${udid}" names a HarmonyOS emulator instance, not a device to drive. Start it with ` +
        "boot-device and drive the `harmony-<connectKey>` id that returns.",
      {
        error_code: FAILURE_CODES.HARMONY_DEVICE_ID_INVALID,
        failure_stage: "harmony_connect_key",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  return udid.startsWith(HARMONY_ID_PREFIX) ? udid.slice(HARMONY_ID_PREFIX.length) : udid;
}

/** Returns the platform a `udid` belongs to based on its shape. */
export function classifyDevice(udid: string): Platform {
  if (udid.startsWith(REMOTE_PREFIX)) return "ios-remote";
  if (udid.startsWith(VEGA_SERIAL_PREFIX)) return "vega";
  if (udid.startsWith(CHROMIUM_ID_PREFIX)) return "chromium";
  if (udid.startsWith(HARMONY_ID_PREFIX)) return "harmony";
  return IOS_UDID_SHAPE.test(udid) || IOS_PHYSICAL_UDID_SHAPE.test(udid) ? "ios" : "android";
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
 * Kind is defaulted by shape (a physical-iOS-shaped UDID gets 'device');
 * platform impls can enrich the result with name/state/sdkLevel from
 * simctl/adb/sim-remote.
 *
 * Vega is VVD-only: the tool-server neither connects to nor detects physical
 * Fire TV hardware, so every `amazon-` serial resolves to kind `vvd` and never
 * hits the `device` rejection in the `vega: { vvd: true }` capability gate.
 */
export function resolveDevice(udid: string): DeviceInfo {
  const platform = classifyDevice(udid);

  const kind: DeviceKind =
    platform === "ios"
      ? isIosPhysicalUdid(udid)
        ? "device"
        : "simulator"
      : platform === "ios-remote"
        ? "simulator"
        : platform === "vega"
          ? "vvd"
          : platform === "harmony"
            ? udid.startsWith(HARMONY_EMULATOR_ID_PREFIX)
              ? "emulator"
              : "device"
            : platform === "android"
              ? isAndroidEmulatorSerial(udid)
                ? "emulator"
                : "device"
              : "app";
  return { id: udid, platform, kind };
}

/**
 * True for physical iPhone hardware. Always check platform AND kind: a
 * bare `kind === "device"` also matches physical ANDROID hardware
 * (resolveDevice above assigns it to non-emulator Android serials), so the
 * short spelling silently changes meaning outside an ios-platform guard.
 */
export function isIosPhysicalDevice(device: Pick<DeviceInfo, "platform" | "kind">): boolean {
  return device.platform === "ios" && device.kind === "device";
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
