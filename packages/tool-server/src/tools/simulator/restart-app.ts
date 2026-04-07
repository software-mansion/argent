import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("App bundle identifier (e.g. com.apple.MobileSMS)"),
});

export const restartAppTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { restarted: boolean; bundleId: string }
> = {
  id: "restart-app",
  description: `Restart an app on the simulator by terminating then relaunching it by bundle ID.
Use when you need a clean in-memory state without a full reinstall. Returns { restarted, bundleId }. Fails if the bundle ID is not installed on the simulator.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const { udid, bundleId } = params;
    try {
      await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId]);
    } catch {
      // App may not be running — ignore
    }
    await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId]);
    return { restarted: true, bundleId };
  },
};
