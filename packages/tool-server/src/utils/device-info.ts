import { FAILURE_CODES, FailureError } from "@argent/registry";
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
 * Build a `DeviceInfo` from a raw udid, by shape. Kind defaults per platform:
 * 'simulator' for iOS / ios-remote, 'vvd' for Vega, 'emulator'/'device' for
 * Android by serial shape and for HarmonyOS by id prefix, 'app' for Chromium —
 * platform impls can enrich with name/state/sdkLevel via simctl/adb/sim-remote
 * if needed.
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
    platform === "ios" || platform === "ios-remote"
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
