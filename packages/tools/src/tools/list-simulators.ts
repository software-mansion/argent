import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";

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
  description: "List all available iOS simulators with their current state",
  zodSchema,
  services: () => ({}),
  async execute(_services, _params, _options) {
    const { stdout } = await execFileAsync("xcrun", [
      "simctl",
      "list",
      "devices",
      "--json",
    ]);
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

    return { simulators };
  },
};
