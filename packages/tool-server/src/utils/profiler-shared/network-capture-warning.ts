import {
  liveAndroidNetworkCaptureDevices,
  liveAndroidNetworkCaptures,
} from "../../blueprints/android-network-inspector";
import type { RuntimeAppMetadata } from "../../blueprints/js-runtime-debugger";
import { isLogicalKeyedDevice } from "../debugger/device-alias";
import type { RuntimeDevices } from "../debugger/runtime-device";

/**
 * What native network capture does to a profile. The one place the profiler
 * warnings say it, so a new measurement changes one line.
 */
const CAPTURE_COST =
  "It can slow the app, so the timings in this profile can differ from a run without it.";

/**
 * Warning for a profiler start on a device where `native-network-logs` turned
 * native network capture on for an app: the capture follows the app across
 * launches, and nothing else in a profile says the app may run instrumented.
 * "On" is the capture's setting, not a live attachment: the app may not be
 * running, or its current process may not have the agent yet. Undefined when
 * capture is on for no app on the device. Never throws: a warning must not
 * fail the start it annotates.
 *
 * For a `deviceId` that is a Metro logicalDeviceId, which names no device:
 * `runtimeDevices` is where the profiled runtime was found (see
 * {@link foundDeviceWarning} and {@link unresolvedDeviceWarning}).
 * `runtimeApp` is what the runtime said about itself, for when it was not
 * found (see {@link logicalDeviceWarning}).
 */
export function nativeNetworkCaptureWarning(
  deviceId: string,
  runtimeApp?: RuntimeAppMetadata,
  runtimeDevices: RuntimeDevices = { found: [], unresolved: [] }
): string | undefined {
  try {
    const [profiled] = runtimeDevices.found;
    if (profiled !== undefined) {
      const parts = [
        foundDeviceWarning(runtimeDevices.found),
        unresolvedDeviceWarning(runtimeDevices.unresolved, profiled, runtimeApp),
      ].filter((part) => part !== undefined);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    const packages = liveAndroidNetworkCaptures(deviceId);
    if (packages.length === 0) return logicalDeviceWarning(deviceId, runtimeApp);
    const apps = packages.join(", ");
    const one = packages.length === 1;
    return (
      `Native network capture is on for ${apps} on this device: Argent attaches its in-app agent ` +
      `to the processes of ${one ? "that app" : "these apps"}. ${CAPTURE_COST} ` +
      `To profile without it, stop this profile, call native-network-logs with stop: true for ${one ? "that app" : "each of these apps"}, then restart-app and profile again.`
    );
  } catch {
    return undefined;
  }
}

/**
 * For a logicalDeviceId session whose runtime was found: checks every id of
 * that device and no other device. One device can have several ids, one per
 * adb transport, and capture is kept under the one `native-network-logs` was
 * called with. The caller's own id reaches none of them, so the warning names
 * the id each capture is under, as the `udid` to pass.
 */
function foundDeviceWarning(devices: readonly string[]): string | undefined {
  const captures = devices
    .map((device) => ({ device, packages: liveAndroidNetworkCaptures(device) }))
    .filter(({ packages }) => packages.length > 0);
  const first = captures[0];
  if (!first) return undefined;
  const apps = [...new Set(captures.flatMap(({ packages }) => packages))].sort();
  const one = apps.length === 1;
  const where =
    captures.length === 1
      ? `${first.device}, the device this profile runs on`
      : `${captures.map(({ device }) => device).join(" and ")}, adb serials of the device this profile runs on`;
  const stop =
    captures.length === 1
      ? `with udid ${first.device} and stop: true for ${one ? "that app" : "each of these apps"}`
      : `with stop: true for ${captures
          .flatMap(({ device, packages }) => packages.map((pkg) => `${pkg} with udid ${device}`))
          .join(", ")}`;
  return (
    `Native network capture is on for ${apps.join(", ")} on ${where}: Argent attaches its in-app agent ` +
    `to the processes of ${one ? "that app" : "these apps"}. ${CAPTURE_COST} ` +
    `To profile without it, stop this profile, call native-network-logs ${stop}, ` +
    `then restart-app on ${first.device} and profile again.`
  );
}

/**
 * For a logicalDeviceId session whose runtime was found, the serials whose
 * logcat could not be read (see `findRuntimeDevices`): each may be another adb
 * transport of the profiled device, or another device. Like
 * {@link logicalDeviceWarning}, only capture for the profiled app is named, and
 * only for an Android runtime.
 */
function unresolvedDeviceWarning(
  unresolved: readonly string[],
  profiled: string,
  runtimeApp: RuntimeAppMetadata | undefined
): string | undefined {
  const appId = runtimeApp?.appId;
  if (runtimeApp?.platform !== "android" || !appId) return undefined;
  const serials = unresolved.filter((serial) => liveAndroidNetworkCaptures(serial).includes(appId));
  if (serials.length === 0) return undefined;
  const one = serials.length === 1;
  return (
    `Native network capture is on for ${appId} on ${serials.join(", ")}, ` +
    `${one ? "which" : "each of which"} may also be the device this profile runs on: its logcat ` +
    `could not be read to tell. Argent attaches its in-app agent to the processes of that app there. ` +
    `${CAPTURE_COST} To profile without it, stop this profile, call native-network-logs with stop: true ` +
    `for ${appId} ${one ? `with udid ${serials[0]}` : `once with each of ${serials.map((serial) => `udid ${serial}`).join(", ")}`}, ` +
    `then restart-app on ${profiled} and profile again.`
  );
}

/**
 * With two or more devices on one Metro, the debugger is connected with a Metro
 * logicalDeviceId, which names no device, so the lookup by device finds
 * nothing. Only the runtime itself can say where it runs, and when that probe
 * found nothing, the runtime still says which app it is and on which
 * platform, so an Android runtime is warned when capture is on for its app on
 * any Android device, naming them: the id cannot say which one is profiled. An
 * iOS runtime, or one that did not say, is never warned. A `deviceId` that
 * names a device is never matched by app, which could point at another device.
 */
function logicalDeviceWarning(
  deviceId: string,
  runtimeApp: RuntimeAppMetadata | undefined
): string | undefined {
  const appId = runtimeApp?.appId;
  if (!isLogicalKeyedDevice(deviceId) || runtimeApp?.platform !== "android" || !appId) {
    return undefined;
  }
  const serials = liveAndroidNetworkCaptureDevices(appId);
  if (serials.length === 0) return undefined;
  const one = serials.length === 1;
  return (
    `Native network capture is on for ${appId} on ${serials.join(", ")}, ` +
    `${one ? "which" : "one of which"} may be the device this profile runs on: its device_id is a ` +
    `Metro logicalDeviceId, which does not say which device it is. Argent attaches its in-app agent ` +
    `to the processes of that app there. ${CAPTURE_COST} ` +
    `To profile without it, stop this profile, call native-network-logs with stop: true for ${appId} on ` +
    `${one ? "that device" : "each of those devices"}, then restart-app and profile again.`
  );
}
