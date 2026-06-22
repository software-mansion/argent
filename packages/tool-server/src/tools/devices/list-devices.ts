import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { isFlagEnabled } from "@argent/configuration-core";
import { listAndroidDevices, listAvds } from "../../utils/adb";
import { listIosSimulators, listIosDevices } from "../../utils/ios-devices";
import { discoverChromiumDevices, type ChromiumDevice } from "../../utils/chromium-discovery";

const PHYSICAL_IOS_FLAG = "physical-ios-devices";

type IosDevice = {
  platform: "ios";
  udid: string;
  name: string;
  state: string;
  // "simulator" for an `xcrun simctl` simulator, "device" for a physical iPhone
  // discovered via `xcrun devicectl` and driven over CoreDevice (pymobiledevice3).
  kind: "simulator" | "device";
  // simulators only (the iOS runtime, e.g. "com.apple.CoreSimulator.SimRuntime.iOS-18-5")
  runtime?: string;
  // physical devices only (Apple product type, e.g. "iPhone15,4")
  productType?: string | null;
};

type AndroidDevice = {
  platform: "android";
  serial: string;
  state: string;
  isEmulator: boolean;
  // "emulator" for a local AVD, "device" for a physical phone (USB or wireless
  // adb). The two are driven by different simulator-server controllers, so the
  // kind is surfaced here for parity with iOS terminology and so consumers can
  // tell a connected phone apart from an emulator at a glance.
  kind: "emulator" | "device";
  model: string | null;
  avdName: string | null;
  sdkLevel: number | null;
};

export type ListDevicesResult = {
  devices: Array<IosDevice | AndroidDevice | ChromiumDevice>;
  avds: Array<{ name: string }>;
};

// A simulator is ready when "Booted"; a physical device is ready when "connected".
const iosReady = (d: IosDevice): boolean => d.state === "Booted" || d.state === "connected";

function sortIos(a: IosDevice, b: IosDevice): number {
  const aReady = iosReady(a) ? 0 : 1;
  const bReady = iosReady(b) ? 0 : 1;
  if (aReady !== bReady) return aReady - bReady;
  const aIpad = a.name.includes("iPad") ? 1 : 0;
  const bIpad = b.name.includes("iPad") ? 1 : 0;
  return aIpad - bIpad;
}

function sortAndroid(a: AndroidDevice, b: AndroidDevice): number {
  const aReady = a.state === "device" ? 0 : 1;
  const bReady = b.state === "device" ? 0 : 1;
  if (aReady !== bReady) return aReady - bReady;
  const aEmu = a.isEmulator ? 0 : 1;
  const bEmu = b.isEmulator ? 0 : 1;
  return aEmu - bEmu;
}

// Float booted/ready devices to the top of the merged list regardless of
// platform — without this, all iOS entries are emitted before any Android.
function readinessRank(d: IosDevice | AndroidDevice | ChromiumDevice): number {
  if (d.platform === "ios") return iosReady(d) ? 0 : 1;
  if (d.platform === "android") return d.state === "device" ? 0 : 1;
  return 0; // Chromium entries are only listed when their CDP is responsive
}

const zodSchema = z.object({});

export const listDevicesTool: ToolDefinition<Record<string, never>, ListDevicesResult> = {
  id: "list-devices",
  description: `List iOS simulators, Android emulators, connected physical Android devices, and running Chromium apps in one place.
Use at the start of a session to pick a target id ('udid' for iOS entries, 'serial' for Android, 'id' for Chromium) to pass to interaction tools, and to see which targets are already running.
Returns { devices, avds } where each device carries a 'platform' discriminator ('ios', 'android', or 'chromium'), and 'avds' lists Android AVDs that can be booted via boot-device.
Android entries also carry a 'kind' ('emulator' for a local AVD, 'device' for a physical phone connected over USB / wireless adb) — physical phones are detected from \`adb devices\` (any serial that is not an \`emulator-*\` one) and are driven through the same interaction tools as emulators; they do not need boot-device (just connect the phone with USB debugging authorised).
iOS entries likewise carry a 'kind' ('simulator', or 'device' for a connected physical iPhone). Physical iOS devices require the 'physical-ios-devices' flag (\`argent enable physical-ios-devices\`), iOS 27+, and a running CoreDevice tunnel (\`sudo pymobiledevice3 remote tunneld\`); they support screenshot, gesture-tap, gesture-swipe, and button.
Chromium apps are discovered by probing CDP debugging ports (default 9222; extend via the ARGENT_CHROMIUM_PORTS=<comma-separated-ports> env var). They must already be running with --remote-debugging-port=<port> — use boot-device with chromiumAppPath to launch one.
Booted/ready devices are listed first. Platforms whose CLI is unavailable are silently omitted — an empty result usually means xcode-select or Android platform-tools is not installed.`,
  alwaysLoad: true,
  searchHint:
    "list devices simulators emulators avd serial udid ios android chromium app session start",
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    const physicalIosEnabled = isFlagEnabled(PHYSICAL_IOS_FLAG);
    const [ios, iosPhysical, android, avds, chromium] = await Promise.all([
      listIosSimulators(),
      physicalIosEnabled ? listIosDevices().catch(() => []) : Promise.resolve([]),
      listAndroidDevices().catch(() => []),
      listAvds(),
      discoverChromiumDevices().catch(() => []),
    ]);
    const iosTagged: IosDevice[] = [
      ...ios.map(
        (s): IosDevice => ({
          platform: "ios",
          kind: "simulator",
          udid: s.udid,
          name: s.name,
          state: s.state,
          runtime: s.runtime,
        })
      ),
      ...iosPhysical.map(
        (d): IosDevice => ({
          platform: "ios",
          kind: "device",
          udid: d.udid,
          name: d.name,
          state: d.state,
          productType: d.productType,
        })
      ),
    ];
    iosTagged.sort(sortIos);
    const androidTagged: AndroidDevice[] = android.map((d) => ({
      platform: "android",
      serial: d.serial,
      state: d.state,
      isEmulator: d.isEmulator,
      kind: d.isEmulator ? "emulator" : "device",
      model: d.model,
      avdName: d.avdName,
      sdkLevel: d.sdkLevel,
    }));
    androidTagged.sort(sortAndroid);

    const devices: Array<IosDevice | AndroidDevice | ChromiumDevice> = [
      ...iosTagged,
      ...androidTagged,
      ...chromium,
    ];
    devices.sort((a, b) => readinessRank(a) - readinessRank(b));

    return { devices, avds };
  },
};
