import {
  liveAndroidNetworkCaptureDevices,
  liveAndroidNetworkCaptures,
} from "../../blueprints/android-network-inspector";
import {
  liveIosNetworkCaptureDevices,
  liveIosNetworkCaptures,
} from "../../blueprints/ios-network-records";
import type { RuntimeAppMetadata } from "../../blueprints/js-runtime-debugger";
import { isLogicalKeyedDevice } from "../debugger/device-alias";

/**
 * What native network capture does to a profile. The one place the profiler
 * warnings say it, so a new measurement changes one line.
 */
const CAPTURE_COST =
  "It can slow the app, so the timings in this profile can differ from a run without it.";

type CapturePlatform = "android" | "ios";

/** What the in-app agent does to the processes of the apps named before it. */
function agentSentence(platform: CapturePlatform, one: boolean, where = ""): string {
  return platform === "android"
    ? `Argent attaches its in-app agent to the processes of ${one ? "that app" : "these apps"}${where}.`
    : `Argent's in-app agent captures the requests of ${one ? "that app's" : "these apps'"} processes${where}.`;
}

/**
 * Warning for a profiler start on a device where `network-capture-start` turned
 * native network capture on for an app: the capture follows the app across
 * launches, and nothing else in a profile says the app may run instrumented.
 * After `network-capture-stop` the app is no longer named.
 * "On" is the capture's setting, not a live attachment: the app may not be
 * running, or its current process may not have the agent yet. On iOS an app
 * counts only after it has connected, because an app that never connected,
 * such as a mistyped bundle id, has no process to capture. Undefined when no
 * app counts on the device. Never throws: a warning must not fail the start it
 * annotates.
 *
 * `runtimeApp` is what the profiled JS runtime said about itself, for a
 * `deviceId` that names no device (see {@link logicalDeviceWarning}).
 */
export function nativeNetworkCaptureWarning(
  deviceId: string,
  runtimeApp?: RuntimeAppMetadata
): string | undefined {
  let platform: CapturePlatform = "android";
  let packages: string[];
  try {
    packages = liveAndroidNetworkCaptures(deviceId);
    if (packages.length === 0) {
      platform = "ios";
      packages = liveIosNetworkCaptures(deviceId);
    }
    if (packages.length === 0) return logicalDeviceWarning(deviceId, runtimeApp);
  } catch {
    return undefined;
  }
  const apps = packages.join(", ");
  const one = packages.length === 1;
  const remedy = `call network-capture-stop for ${one ? "that app" : "each of these apps"}`;
  return (
    `Native network capture is on for ${apps} on this device: ${agentSentence(platform, one)} ${CAPTURE_COST} ` +
    `To profile without it, stop this profile, ${remedy}, then restart-app and profile again.`
  );
}

/**
 * With two or more devices on one Metro, the debugger is connected with a Metro
 * logicalDeviceId, which no device id can be derived from, so the lookup by
 * device finds nothing. The runtime still says which app it is and on which
 * platform, so it is warned when capture is on for its app on any device of
 * that platform, naming them: the id cannot say which one is profiled. A
 * runtime that did not say is never warned. A `deviceId` that names a device
 * is never matched by app, which could point at another device.
 */
function logicalDeviceWarning(
  deviceId: string,
  runtimeApp: RuntimeAppMetadata | undefined
): string | undefined {
  const appId = runtimeApp?.appId;
  const platform = runtimeApp?.platform;
  if (!isLogicalKeyedDevice(deviceId) || !appId) return undefined;
  if (platform !== "android" && platform !== "ios") return undefined;
  const devices =
    platform === "android"
      ? liveAndroidNetworkCaptureDevices(appId)
      : liveIosNetworkCaptureDevices(appId);
  if (devices.length === 0) return undefined;
  const one = devices.length === 1;
  const those = one ? "that device" : "each of those devices";
  const remedy = `call network-capture-stop for ${appId} on ${those}`;
  return (
    `Native network capture is on for ${appId} on ${devices.join(", ")}, ` +
    `${one ? "which" : "one of which"} may be the device this profile runs on: its device_id is a ` +
    `Metro logicalDeviceId, which does not say which device it is. ${agentSentence(platform, true, " there")} ` +
    `${CAPTURE_COST} To profile without it, stop this profile, ${remedy}, then restart-app and profile again.`
  );
}
