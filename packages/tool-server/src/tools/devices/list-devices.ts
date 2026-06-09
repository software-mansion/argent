import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { listAndroidDevices, listAvds } from "../../utils/adb";
import { listIosSimulators, type IosSimulator } from "../../utils/ios-devices";
import { listPhysicalDevices, type PhysicalDevice } from "../../utils/ios-physical-device";

type IosSimulatorDevice = IosSimulator & { platform: "ios"; kind: "simulator" };
type IosPhysicalDevice = PhysicalDevice & { platform: "ios"; kind: "physical" };
type IosDevice = IosSimulatorDevice | IosPhysicalDevice;

type AndroidDevice = {
  platform: "android";
  serial: string;
  state: string;
  isEmulator: boolean;
  model: string | null;
  avdName: string | null;
  sdkLevel: number | null;
};

type ListDevicesResult = {
  devices: Array<IosDevice | AndroidDevice>;
  avds: Array<{ name: string }>;
  // Only present when a physical-device scan was requested but devicectl failed
  // (e.g. Xcode < 15, device locked/untrusted) — lets the caller surface the
  // reason instead of silently reporting "no devices".
  physicalDevicesError?: string;
};

function sortIos(a: IosSimulatorDevice, b: IosSimulatorDevice): number {
  const aBooted = a.state === "Booted" ? 0 : 1;
  const bBooted = b.state === "Booted" ? 0 : 1;
  if (aBooted !== bBooted) return aBooted - bBooted;
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
// Connected physical devices are always ready.
function readinessRank(d: IosDevice | AndroidDevice): number {
  if (d.platform === "ios") {
    if (d.kind === "physical") return 0;
    return d.state === "Booted" ? 0 : 1;
  }
  return d.state === "device" ? 0 : 1;
}

const zodSchema = z.object({
  include_physical_devices: z
    .boolean()
    .optional()
    .describe(
      "Also scan for physical iOS devices connected via USB or Wi-Fi (tagged `kind: \"physical\"`). Defaults to false — the scan is slower (~5s) and requires Xcode 15+. Physical devices support profiling/debugging only, not automated interaction."
    ),
});

type Params = z.infer<typeof zodSchema>;

export const listDevicesTool: ToolDefinition<Params, ListDevicesResult> = {
  id: "list-devices",
  description: `List iOS simulators and Android devices/emulators in one place.
Use at the start of a session to pick a target id ('udid' for iOS entries, 'serial' for Android) to pass to interaction tools, and to see which targets are already running.
Returns { devices, avds } where each device carries a 'platform' discriminator ('ios' or 'android'); iOS entries also carry 'kind' ('simulator' or 'physical'). 'avds' lists Android AVDs that can be booted via boot-device.
Set include_physical_devices: true to also scan for connected physical iOS devices (slower, requires Xcode 15+); physical devices support profiling/debugging only, not automated interaction.
Booted/ready devices are listed first. Platforms whose CLI is unavailable are silently omitted — an empty result usually means xcode-select or Android platform-tools is not installed.`,
  alwaysLoad: true,
  searchHint:
    "list devices simulators emulators physical avd serial udid ios android session start",
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const includePhysical = params.include_physical_devices ?? false;
    const [ios, android, avds, physical] = await Promise.all([
      listIosSimulators(),
      listAndroidDevices().catch(() => []),
      listAvds(),
      includePhysical ? listPhysicalDevices() : Promise.resolve(null),
    ]);

    const iosSimTagged: IosSimulatorDevice[] = ios.map((s) => ({
      platform: "ios",
      kind: "simulator",
      ...s,
    }));
    iosSimTagged.sort(sortIos);

    let physicalDevicesError: string | undefined;
    const iosPhysTagged: IosPhysicalDevice[] = [];
    if (physical) {
      physicalDevicesError = physical.error;
      for (const pd of physical.devices) {
        iosPhysTagged.push({ platform: "ios", kind: "physical", ...pd });
      }
    }

    const androidTagged: AndroidDevice[] = android.map((d) => ({
      platform: "android",
      serial: d.serial,
      state: d.state,
      isEmulator: d.isEmulator,
      model: d.model,
      avdName: d.avdName,
      sdkLevel: d.sdkLevel,
    }));
    androidTagged.sort(sortAndroid);

    const devices: Array<IosDevice | AndroidDevice> = [
      ...iosSimTagged,
      ...iosPhysTagged,
      ...androidTagged,
    ];
    devices.sort((a, b) => readinessRank(a) - readinessRank(b));

    return physicalDevicesError ? { devices, avds, physicalDevicesError } : { devices, avds };
  },
};
