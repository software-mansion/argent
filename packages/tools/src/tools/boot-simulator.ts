import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { Tool } from "../types";

const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  udid: z.string().describe("The UDID of the simulator to boot"),
});

const outputSchema = z.object({
  udid: z.string(),
  booted: z.literal(true),
});

export const bootSimulatorTool: Tool<
  typeof inputSchema,
  z.infer<typeof outputSchema>
> = {
  name: "boot-simulator",
  description: "Boot an iOS simulator by UDID",
  inputSchema,
  outputSchema,
  async execute(input, _signal) {
    try {
      await execFileAsync("xcrun", ["simctl", "boot", input.udid]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // xcrun simctl boot exits with an error if the device is already booted — treat as success
      if (!message.includes("Unable to boot device in current state: Booted")) {
        throw err;
      }
    }
    return { udid: input.udid, booted: true };
  },
};
