import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { listAndroidDevices, listAvds } from "../../utils/adb";

const zodSchema = z.object({});

export const androidListEmulatorsTool: ToolDefinition = {
  id: "android-list-emulators",
  description:
    "List Android devices and emulators known to adb, plus available AVDs from `emulator -list-avds`. " +
    "Use when you need a `serial` to pass to other android-* tools, or to check which emulators are already running. " +
    "Returns { devices: [{ serial, state, isEmulator, model, avdName, sdkLevel }], avds: [{ name }] }. " +
    "`state` is `device` (ready), `offline`, or `unauthorized`. " +
    "Requires the Android SDK Platform Tools (adb) on PATH; AVD listing requires the Emulator package.",
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    const [devices, avds] = await Promise.all([listAndroidDevices(), listAvds()]);
    // Sort ready devices first, then emulators before physical, for a predictable "pick the first" default.
    devices.sort((a, b) => {
      const aReady = a.state === "device" ? 0 : 1;
      const bReady = b.state === "device" ? 0 : 1;
      if (aReady !== bReady) return aReady - bReady;
      const aEmu = a.isEmulator ? 0 : 1;
      const bEmu = b.isEmulator ? 0 : 1;
      return aEmu - bEmu;
    });
    return { devices, avds };
  },
};
