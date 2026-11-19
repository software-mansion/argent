import { adbShell } from "../adb";
import { resolveDevice } from "../device-info";
import { findIosSimulator } from "../ios-devices";

/**
 * Which device names a Metro target may carry for `deviceId`, or undefined
 * when the id gives no name to match.
 *
 * Metro never echoes a udid or serial, only the name the app reported for its
 * device, so this is how a `list-devices` id is told apart from the other
 * devices on a shared Metro.
 *
 * - An iOS simulator reports `UIDevice.name`, which is the simulator's name.
 * - Android reports `getFriendlyDeviceName()`: `Build.MODEL`, followed by
 *   ` - <release> - API <sdk>` everywhere but Genymotion.
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
      const name = (await findIosSimulator(deviceId))?.name;
      return name ? (reported) => reported === name : undefined;
    }
    if (device.platform === "android") {
      const model = (
        await adbShell(deviceId, "getprop ro.product.model", { timeoutMs: 5_000 })
      ).trim();
      return model
        ? (reported) => reported === model || reported.startsWith(`${model} - `)
        : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
