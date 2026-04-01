import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";

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

const zodSchema = z.object({});

export const listSimulatorsTool: ToolDefinition = {
  id: "list-simulators",
  description: `List all available iOS simulators with their name, UDID, runtime, and current state (Booted/Shutdown).
Use when you need to find a simulator UDID before calling boot-simulator, simulator-server, or any tool that requires a udid parameter.

No parameters required.
Example output entry: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "name": "iPhone 16 Pro", "state": "Booted", "runtime": "com.apple.CoreSimulator.SimRuntime.iOS-18-4" }
Returns { simulators: [...] } sorted with Booted simulators first. Returns an error if xcrun is unavailable (Xcode not installed).`,
  zodSchema,
  services: () => ({}),
  async execute(_services, _params, _options) {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "--json"]);
    const data: SimctlOutput = JSON.parse(stdout);
    const simulators: {
      udid: string;
      name: string;
      state: string;
      runtime: string;
      isAvailable: boolean;
    }[] = [];

    for (const [runtimeId, devices] of Object.entries(data.devices)) {
      if (!runtimeId.includes("iOS")) continue;
      for (const device of devices) {
        if (!device.isAvailable) continue;
        simulators.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          runtime: runtimeId,
          isAvailable: device.isAvailable,
        });
      }
    }

    simulators.sort((a, b) => {
      const aBooted = a.state === "Booted" ? 0 : 1;
      const bBooted = b.state === "Booted" ? 0 : 1;
      if (aBooted !== bBooted) return aBooted - bBooted;
      const aIpad = a.name.includes("iPad") ? 1 : 0;
      const bIpad = b.name.includes("iPad") ? 1 : 0;
      return aIpad - bIpad;
    });

    return { simulators };
  },
};
