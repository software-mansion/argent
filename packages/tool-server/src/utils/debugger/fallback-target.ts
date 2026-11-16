import { FAILURE_CODES, FailureError } from "@argent/registry";
import { classifyDevice } from "../device-info";
import { androidDeviceNames, otherAndroidDeviceOnline } from "./android-device-name";
import type { CDPTarget } from "./discovery";
import { describeDevice, macosAppBundleIdOf } from "./target-selection";

function otherDeviceError(deviceId: string, port: number, why: string): FailureError {
  return new FailureError(
    `No debugger target matches device_id "${deviceId}". Metro on port ${port} lists one ` +
      `device, ${why} Launch the app on "${deviceId}" and connect it to this Metro, or pass ` +
      `the port of the Metro it uses, then retry.`,
    {
      error_code: FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
      failure_stage: "debugger_select_target",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
  );
}

/**
 * Check the runtime `selectTarget` took when `deviceId` matched no target and
 * Metro listed one device. Metro never lists a simulator UDID or an adb
 * serial, so the fallback is how those ids connect at all, but it takes any
 * runtime, also one on another device.
 *
 * Throws when the runtime is provably on another device: a Mac app's runtime
 * (a Mac app id would have matched it exactly), or, for an Android serial, a
 * runtime whose device name is not the one that device reports. Otherwise
 * returns a note that names the runtime, for the tools that report the
 * connection, unless the runtime is provably on this device: an Android serial
 * that reports the runtime's name while adb lists no other online device. A
 * legacy-inspector runtime (Vega, RN 0.72) gets no note either: it lists no
 * logicalDeviceId, so no device_id can ever pick it and the fallback is the
 * only way it connects.
 *
 * Both adb reads run at once, so a slow adb costs at most 8 s: the adb path
 * lookup (2 s, cached for a minute), then the `adb devices` timeout (6 s).
 */
export async function checkFallbackTarget(
  target: CDPTarget,
  deviceId: string,
  port: number
): Promise<string | undefined> {
  const device = describeDevice(target);
  const macBundleId = macosAppBundleIdOf(target);
  if (macBundleId) {
    throw otherDeviceError(
      deviceId,
      port,
      `the ${device}, which runs on this Mac. The React profiler tools reach it with the ` +
        `device id "macos-app-${macBundleId}".`
    );
  }
  const keyed = Boolean(target.reactNative?.logicalDeviceId);
  if (target.deviceName && classifyDevice(deviceId) === "android") {
    const [names, otherOnline] = await Promise.all([
      androidDeviceNames(deviceId),
      keyed ? otherAndroidDeviceOnline(deviceId) : true,
    ]);
    if (names && !names.includes(target.deviceName)) {
      throw otherDeviceError(
        deviceId,
        port,
        `${device}, and "${deviceId}" reports the name "${names[0]}".`
      );
    }
    if (names && !otherOnline) return undefined;
  }
  if (!keyed) return undefined;
  const app = target.appId ? `, app ${target.appId}` : "";
  return (
    `Argent connected to the only runtime on Metro port ${port}: ${device}${app}. Metro does ` +
    `not list device ids, so this is a guess. If the app does not run on this device_id, ` +
    `launch it there, call stop-all-simulator-servers with devices [this device_id], and ` +
    `connect again.`
  );
}
