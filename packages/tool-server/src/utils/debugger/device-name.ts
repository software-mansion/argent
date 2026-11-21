import {
  ADB_DEVICES_TIMEOUT_MS,
  ENRICH_TIMEOUT_MS,
  adbShell,
  parseAdbDevices,
  runAdb,
} from "../adb";
import { resolveDevice } from "../device-info";
import { externalNativeId } from "../external-devices";
import { listIosSimulators } from "../ios-devices";

/**
 * Which device names a Metro target may carry for `deviceId`, or undefined
 * when the id gives no name that only this device has.
 *
 * Metro never echoes a udid or serial, only the name the app reported for its
 * device, so this is how a `list-devices` id is told apart from the other
 * devices on a shared Metro.
 *
 * The name must be unique among the devices that could be on Metro, not only
 * among those that are: when a device whose app is not running shares its
 * name with one whose app is, its id would resolve to the other device.
 *
 * - An iOS simulator reports `UIDevice.name`, which is the simulator's name.
 *   It must be booted, and no other booted simulator may have its name. A
 *   simulator that is not booted runs no app, so Xcode's one "iPhone 17 Pro"
 *   per runtime does not count against it.
 * - Android reports `getFriendlyDeviceName()`: `Build.MODEL - <release> - API
 *   <sdk>`, or `Build.MODEL` alone on Genymotion. No other attached device may
 *   report the same name. `sdk_gphone64_arm64` is the model of every recent
 *   Google image, so the release and API level are what usually tell two
 *   emulators apart.
 *
 * A physical iPhone is skipped: since iOS 16 it reports a generic "iPhone".
 * Failing lookups give undefined, which leaves the caller with the usual
 * logicalDeviceId error rather than a second, unrelated one.
 */
export async function deviceNameMatcher(
  deviceId: string
): Promise<((name: string) => boolean) | undefined> {
  const device = resolveDevice(deviceId);
  try {
    if (device.platform === "ios" && device.kind === "simulator") {
      return await iosSimulatorMatcher(externalNativeId(deviceId));
    }
    if (device.platform === "android") {
      return await androidMatcher(externalNativeId(deviceId));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function iosSimulatorMatcher(udid: string): Promise<((name: string) => boolean) | undefined> {
  const booted = (await listIosSimulators()).filter((s) => s.state === "Booted");
  const own = booted.find((s) => s.udid === udid);
  if (!own) return undefined;
  if (booted.some((s) => s.udid !== udid && s.name === own.name)) return undefined;
  return (reported) => reported === own.name;
}

/** The names React Native can report for an Android device: with and without the suffix. */
async function androidNames(serial: string): Promise<{ full: string; model: string } | undefined> {
  const out = await adbShell(
    serial,
    'echo "$(getprop ro.product.model)|$(getprop ro.build.version.release)|$(getprop ro.build.version.sdk)"',
    { timeoutMs: ENRICH_TIMEOUT_MS }
  );
  const [model = "", release = "", sdk = ""] = out.trim().split("|");
  if (!model) return undefined;
  return { full: `${model} - ${release} - API ${sdk}`, model };
}

async function androidMatcher(serial: string): Promise<((name: string) => boolean) | undefined> {
  const { stdout } = await runAdb(["devices"], { timeoutMs: ADB_DEVICES_TIMEOUT_MS });
  const others = parseAdbDevices(stdout).filter((d) => d.state === "device" && d.serial !== serial);
  const [own, ...rest] = await Promise.all([
    androidNames(serial),
    ...others.map((d) => androidNames(d.serial).catch(() => null)),
  ]);
  if (!own) return undefined;
  // A device that did not answer could have any name, so it could be the twin.
  if (rest.some((names) => names === null)) return undefined;
  const fullTaken = rest.some((names) => names?.full === own.full);
  const modelTaken = rest.some((names) => names?.model === own.model);
  if (fullTaken) return undefined;
  return (reported) => reported === own.full || (!modelTaken && reported === own.model);
}

/**
 * The logicalDeviceId each udid or serial was matched to by name.
 *
 * The match holds only while both devices are on Metro. When the app on the
 * matched device exits, a reconnect sees only the other device, and the
 * single-device fallback would move the session there and keep it there after
 * the app is back. Keeping the id the name led to lets `selectTarget` refuse
 * that, as it refuses a logicalDeviceId that left. A later match by name, after
 * a reinstall gave the app a new id, replaces it.
 */
const nameMatchedLogicalIds = new Map<string, string>();

export function nameMatchedLogicalDeviceId(deviceId: string): string | undefined {
  return nameMatchedLogicalIds.get(deviceId);
}

export function rememberNameMatch(deviceId: string, logicalDeviceId: string | undefined): void {
  if (logicalDeviceId) nameMatchedLogicalIds.set(deviceId, logicalDeviceId);
}
