import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { listAndroidDevices, listAvds } from "../../utils/adb";
import { listIosSimulators, type IosSimulator } from "../../utils/ios-devices";

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
Use at the start of a session to pick a target id ('udid' for iOS entries, 'serial' for Android) to pass to interaction tools, and to see which targets are already running.
Returns { devices, avds } where each device carries a 'platform' discriminator ('ios' or 'android'), and 'avds' lists Android AVDs that can be booted via boot-device.
Booted/ready devices are listed first. Platforms whose CLI is unavailable are silently omitted — an empty result usually means xcode-select or Android platform-tools is not installed.`,
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

    return { devices: [...iosTagged, ...androidTagged], avds };
  },
};
