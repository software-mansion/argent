import {
  liveAndroidNetworkCaptureDevices,
  liveAndroidNetworkCaptures,
} from "../../blueprints/android-network-inspector";
import type { RuntimeAppMetadata } from "../../blueprints/js-runtime-debugger";
import { isLogicalKeyedDevice } from "../debugger/device-alias";

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
 * `runtimeApp` is what the profiled JS runtime said about itself, for a
 * `deviceId` that names no device (see {@link logicalDeviceWarning}).
 */
export function nativeNetworkCaptureWarning(
  deviceId: string,
  runtimeApp?: RuntimeAppMetadata
): string | undefined {
  let packages: string[];
  try {
    packages = liveAndroidNetworkCaptures(deviceId);
    if (packages.length === 0) return logicalDeviceWarning(deviceId, runtimeApp);
  } catch {
    return undefined;
  }
  const apps = packages.join(", ");
  const one = packages.length === 1;
  return (
    `Native network capture is on for ${apps} on this device: Argent attaches its in-app agent ` +
    `to the processes of ${one ? "that app" : "these apps"}. ${CAPTURE_COST} ` +
    `To profile without it, call native-network-logs with stop: true for ${one ? "that app" : "each of these apps"}, then restart-app.`
  );
}

/**
 * With two or more devices on one Metro, the debugger is connected with a Metro
 * logicalDeviceId, which no adb serial can be derived from, so the lookup by
 * device finds nothing. The runtime still says which app it is and on which
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
    `To profile without it, call native-network-logs with stop: true for ${appId} on ` +
    `${one ? "that device" : "each of those devices"}, then restart-app.`
  );
}
