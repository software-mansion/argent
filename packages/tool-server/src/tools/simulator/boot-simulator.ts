import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z.string().describe("The UDID of the simulator to boot"),
});

export const bootSimulatorTool: ToolDefinition<{ udid: string }> = {
  id: "boot-simulator",
  description: "Boot an iOS simulator by UDID",
  zodSchema,
  services: () => ({}),
  async execute(_services, params, _options) {
    try {
      await execFileAsync("xcrun", ["simctl", "boot", params.udid]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // xcrun simctl boot exits with an error if the device is already booted — treat as success
      if (!message.includes("Unable to boot device in current state: Booted")) {
        throw err;
      }
    }
    return { udid: params.udid, booted: true };
  },
};
