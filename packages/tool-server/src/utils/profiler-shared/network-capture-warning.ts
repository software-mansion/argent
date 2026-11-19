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
import type { RuntimeDevices } from "../debugger/runtime-device";

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
    ? `Argent's in-app agent can run in the processes of ${one ? "that app" : "these apps"}${where}.`
    : `Argent's in-app agent captures the requests of ${one ? "that app's" : "these apps'"} processes${where}.`;
}

/**
 * Warning for a profiler start on a device where `network-capture-start` turned
 * native network capture on for an app: the capture follows the app across
 * launches, and nothing else in a profile says the app may run instrumented.
 * After `network-capture-stop` the app is no longer named, except while its
 * connected process has not acknowledged the stop.
 * "On" is the capture's setting, not a live attachment: the app may not be
 * running, or its current process may not have the agent yet. On iOS an app
 * counts only after it has connected, because an app that never connected,
 * such as a mistyped bundle id, has no process to capture. Undefined when no
 * app counts on the device. Never throws: a warning must not fail the start it
 * annotates.
 *
 * For a `deviceId` that is a Metro logicalDeviceId, which names no device:
 * `runtimeDevices` is where the profiled runtime was found (see
 * {@link foundDeviceWarning}). `runtimeApp` is what the runtime said about
 * itself: it picks the capture to name under a serial that could not be read,
 * and on every device of its platform when the runtime was not found (see
 * {@link logicalDeviceWarning}).
 */
export function nativeNetworkCaptureWarning(
  deviceId: string,
  runtimeApp?: RuntimeAppMetadata,
  runtimeDevices: RuntimeDevices = { found: [], unresolved: [] }
): string | undefined {
  try {
    if (runtimeDevices.found.length > 0) {
      return foundDeviceWarning(runtimeDevices, runtimeApp);
    }
    let platform: CapturePlatform = "android";
    let packages = liveAndroidNetworkCaptures(deviceId);
    if (packages.length === 0) {
      platform = "ios";
      packages = liveIosNetworkCaptures(deviceId);
    }
    if (packages.length === 0) return logicalDeviceWarning(deviceId, runtimeApp);
    const apps = packages.join(", ");
    const one = packages.length === 1;
    const remedy = `call network-capture-stop for ${one ? "that app" : "each of these apps"}`;
    return (
      `Native network capture is on for ${apps} on this device: ${agentSentence(platform, one)} ${CAPTURE_COST} ` +
      `To profile without it, stop this profile, ${remedy}, then restart-app and profile again.`
    );
  } catch {
    return undefined;
  }
}

/**
 * For a logicalDeviceId session whose runtime was found: checks every id of
 * that device and no other device. One device can have several ids, one per
 * adb transport, and capture is kept under the one `network-capture-start` was
 * called with. The caller's own id reaches none of them, so the warning names
 * the id each capture is under, as the `udid` to pass.
 *
 * It also names the serials whose logcat could not be read (see
 * `findRuntimeDevices`) where capture is on for the profiled app: each may be
 * another transport of the profiled device, or another device. Like
 * {@link logicalDeviceWarning}, only capture for the profiled app is named
 * there, and only for an Android runtime. Both kinds share one set of steps.
 */
function foundDeviceWarning(
  { found, unresolved }: RuntimeDevices,
  runtimeApp: RuntimeAppMetadata | undefined
): string | undefined {
  // An iOS runtime is found on one simulator, by its UDID, which is the id
  // iOS capture is kept under.
  const iosApps = found.length === 1 ? liveIosNetworkCaptures(found[0]) : [];
  if (iosApps.length > 0) {
    const [udid] = found;
    const one = iosApps.length === 1;
    return (
      `Native network capture is on for ${iosApps.join(", ")} on ${udid}, the device this profile ` +
      `runs on: ${agentSentence("ios", one)} ${CAPTURE_COST} To profile without it, stop this profile, ` +
      `call network-capture-stop with udid ${udid} for ${one ? "that app" : "each of these apps"}, ` +
      `then restart-app on ${udid} and profile again.`
    );
  }
  const captures = found
    .map((device) => ({ device, packages: liveAndroidNetworkCaptures(device) }))
    .filter(({ packages }) => packages.length > 0);
  const appId = runtimeApp?.platform === "android" ? runtimeApp.appId : undefined;
  const maybe = appId
    ? unresolved.filter((serial) => liveAndroidNetworkCaptures(serial).includes(appId))
    : [];
  const first = captures[0];
  if (!first && (!appId || maybe.length === 0)) return undefined;

  const sentences: string[] = [];
  if (first) {
    const apps = [...new Set(captures.flatMap(({ packages }) => packages))].sort();
    const where =
      captures.length === 1
        ? `${first.device}, the device this profile runs on`
        : `${captures.map(({ device }) => device).join(" and ")}, adb serials of the device this profile runs on`;
    sentences.push(
      `Native network capture is on for ${apps.join(", ")} on ${where}: ` +
        agentSentence("android", apps.length === 1)
    );
  }
  if (appId && maybe.length > 0) {
    const one = maybe.length === 1;
    sentences.push(
      `Native network capture is ${first ? "also " : ""}on for ${appId} on ${maybe.join(", ")}, ` +
        `${one ? "which" : "each of which"} may also be the device this profile runs on: ` +
        `${one ? "its logcat" : "their logcats"} could not be read to tell. ` +
        agentSentence("android", true, " there")
    );
  }

  const stops = [
    ...captures.flatMap(({ device, packages }) => packages.map((app) => ({ app, device }))),
    ...(appId ? maybe.map((device) => ({ app: appId, device })) : []),
  ];
  const stop =
    first && captures.length === 1 && maybe.length === 0
      ? `with udid ${first.device} for ${first.packages.length === 1 ? "that app" : "each of these apps"}`
      : `for ${stops.map(({ app, device }) => `${app} with udid ${device}`).join(", ")}`;
  // Any id of the profiled device restarts it; one of them for every case.
  const restart = first?.device ?? found[0];
  return (
    `${sentences.join(" ")} ${CAPTURE_COST} To profile without it, stop this profile, ` +
    `call network-capture-stop ${stop}, then restart-app on ${restart} and profile again.`
  );
}

/**
 * With two or more devices on one Metro, the debugger is connected with a Metro
 * logicalDeviceId, which names no device, so the lookup by device finds
 * nothing. Only the runtime itself can say where it runs, and when that probe
 * found nothing, the runtime still says which app it is and on which
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
