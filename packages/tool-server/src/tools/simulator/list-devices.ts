import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { listPhysicalDevices } from "../../utils/ios-device";

const execFileAsync = promisify(execFile);

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  deviceTypeIdentifier: string;
  isAvailable: boolean;
}

interface SimctlOutput {
  devices: Record<string, SimctlDevice[]>;
}

const zodSchema = z.object({
  include_physical_devices: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Also scan for physical iOS devices connected via USB or Wi-Fi. Slower (~5s), requires Xcode 15+.",
    ),
});

export const listDevicesTool: ToolDefinition = {
  id: "list-devices",
  description: [
    "List available iOS devices (simulators and optionally physical devices).",
    "By default returns only simulators (fast). Set `include_physical_devices: true` to also scan for physical devices connected via USB or Wi-Fi (slower, requires Xcode 15+).",
    "",
    "WHEN TO INCLUDE PHYSICAL DEVICES:",
    "- User explicitly asks to run/test on a real device",
    "- Task requires device-only hardware: camera, GPS, NFC, Bluetooth, push notifications",
    "- Profiling real-world performance (thermal throttling, actual CPU/GPU)",
    "- Testing on a specific OS version not available in simulators",
    "",
    "IMPORTANT LIMITATION: Physical devices do NOT support automated interaction (taps, swipes, screenshots, describe, etc.) — the user must navigate the device by hand. Only profiling and debugging tools work on physical devices.",
    "",
    "PREFER SIMULATORS for: fast iteration, CI, UI testing, automated interaction, and most development workflows.",
  ].join("\n"),
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const { include_physical_devices } = params as unknown as z.infer<
      typeof zodSchema
    >;

    // Always list simulators
    const { stdout } = await execFileAsync("xcrun", [
      "simctl",
      "list",
      "devices",
      "--json",
    ]);
    const data: SimctlOutput = JSON.parse(stdout);

    const devices: Record<string, unknown>[] = [];

    for (const [runtimeId, runtimeDevices] of Object.entries(data.devices)) {
      if (!runtimeId.includes("iOS")) continue;
      for (const device of runtimeDevices) {
        if (!device.isAvailable) continue;
        devices.push({
          type: "simulator",
          udid: device.udid,
          name: device.name,
          state: device.state,
          runtime: runtimeId,
          isAvailable: device.isAvailable,
        });
      }
    }

    // Sort simulators: booted first, iPhones before iPads
    devices.sort((a, b) => {
      const aBooted = a.state === "Booted" ? 0 : 1;
      const bBooted = b.state === "Booted" ? 0 : 1;
      if (aBooted !== bBooted) return aBooted - bBooted;
      const aIpad = (a.name as string).includes("iPad") ? 1 : 0;
      const bIpad = (b.name as string).includes("iPad") ? 1 : 0;
      return aIpad - bIpad;
    });

    // Optionally scan for physical devices
    if (include_physical_devices) {
      const physicalDevices = await listPhysicalDevices();
      for (const pd of physicalDevices) {
        devices.push({
          type: "physical_device",
          udid: pd.udid,
          name: pd.name,
          model: pd.model,
          osVersion: pd.osVersion,
          connectionType: pd.connectionType,
        });
      }
    }

    return { devices };
  },
};
