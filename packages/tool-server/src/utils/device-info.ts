import {
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type DeviceKind,
  type Platform,
} from "@argent/registry";
import { isFlagEnabled } from "@argent/configuration-core";

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

export function classifyDevice(udid: string): Platform {
  if (udid.startsWith(REMOTE_PREFIX)) return "ios-remote";
  if (udid.startsWith(VEGA_SERIAL_PREFIX)) return "vega";
  if (udid.startsWith(CHROMIUM_ID_PREFIX)) return "chromium";
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

// Unit tests see the flag as ON unless a suite flips it via the seam below:
// device suites across the repo assert shape classification, and a real flag
// read would make them depend on the developer's flags.json (the same reasoning
// as `new Registry()` defaulting every flag to enabled). The vitest setup file
// `test/setup/enable-ios-physical-flag.ts` sets the ON default before each test
// module graph loads; outside tests the override stays undefined and the stored
// flag decides.
let iosPhysicalFlagForTests: boolean | undefined;

export function __setIosPhysicalDevicesFlagForTests(value: boolean): void {
  iosPhysicalFlagForTests = value;
}

/**
 * Kind is defaulted by shape (a physical-iOS-shaped UDID gets 'device');
 * platform impls can enrich the result with name/state/sdkLevel from
 * simctl/adb/sim-remote.
 *
 * Physical iOS hardware ships behind the experimental 'ios-physical-devices'
 * flag, and the gate lives here because resolveDevice is the narrowest waist
 * every hardware-touching path crosses first: tools resolve
 * `iosDeviceRunnerRef` in `services()`, before execute, so any later gate would
 * fire only after the runner was already built, signed and installed on the
 * phone. The flag read hides behind the UDID-shape check, so simulator and
 * Android hot paths never pay it.
 *
 * Vega is VVD-only: the tool-server neither connects to nor detects physical
 * Fire TV hardware, so every `amazon-` serial resolves to kind `vvd` and never
 * hits the `device` rejection in the `vega: { vvd: true }` capability gate.
 */
export function resolveDevice(udid: string): DeviceInfo {
  if (
    isIosPhysicalUdid(udid) &&
    !(iosPhysicalFlagForTests ?? isFlagEnabled("ios-physical-devices"))
  ) {
    throw new FailureError(
      `'${udid}' is a physical iOS device; physical-device support is experimental ` +
        "and currently disabled. Enable it with `argent enable ios-physical-devices`, then retry.",
      {
        error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
        failure_stage: "device_resolution_flag_gate",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

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
