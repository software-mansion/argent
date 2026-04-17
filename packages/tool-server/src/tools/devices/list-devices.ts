import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { listAndroidDevices, listAvds } from "../../utils/adb";
import { listIosSimulators, type IosSimulator } from "../../utils/ios-devices";
import { warmDeviceCache } from "../../utils/platform-detect";

type IosDevice = IosSimulator & { platform: "ios" };

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
};

function sortIos(a: IosDevice, b: IosDevice): number {
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

const zodSchema = z.object({});

export const listDevicesTool: ToolDefinition<Record<string, never>, ListDevicesResult> = {
  id: "list-devices",
  description: `List iOS simulators and Android devices/emulators in one place.
Use when picking a target id at the start of a session ('udid' for iOS entries, 'serial' for Android) or checking which targets are already running before calling interaction tools.
Returns { devices, avds } where each device carries a 'platform' discriminator ('ios' or 'android'), and 'avds' lists Android AVDs that can be booted via boot-device. Booted/ready devices are listed first.
Fails when neither Xcode nor adb is on PATH; platforms whose tooling is unavailable are silently omitted, so an empty result usually means the relevant installer (xcode-select, Android platform-tools) is missing.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    const [ios, android, avds] = await Promise.all([
      listIosSimulators(),
      listAndroidDevices().catch(() => []),
      listAvds(),
    ]);
    const iosTagged: IosDevice[] = ios.map((s) => ({ platform: "ios", ...s }));
    iosTagged.sort(sortIos);
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

    // Populate the classify cache so the next interaction tool call on any of
    // these ids is a cache hit and doesn't re-run simctl + adb.
    warmDeviceCache([
      ...iosTagged.map((d) => ({ udid: d.udid, platform: "ios" as const })),
      ...androidTagged.map((d) => ({ udid: d.serial, platform: "android" as const })),
    ]);

    return { devices: [...iosTagged, ...androidTagged], avds };
  },
};
