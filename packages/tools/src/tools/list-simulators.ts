import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { Tool } from "../types";

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

const inputSchema = z.object({});

const outputSchema = z.object({
  simulators: z.array(
    z.object({
      udid: z.string(),
      name: z.string(),
      state: z.string(),
      runtime: z.string(),
      isAvailable: z.boolean(),
    })
  ),
});

export const listSimulatorsTool: Tool<
  typeof inputSchema,
  z.infer<typeof outputSchema>
> = {
  name: "list-simulators",
  description: "List all available iOS simulators with their current state",
  inputSchema,
  outputSchema,
  async execute(_input, _signal) {
    const { stdout } = await execFileAsync("xcrun", [
      "simctl",
      "list",
      "devices",
      "--json",
    ]);
    const data: SimctlOutput = JSON.parse(stdout);
    const simulators: z.infer<typeof outputSchema>["simulators"] = [];

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
