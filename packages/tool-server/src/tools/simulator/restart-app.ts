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
  description: `Terminate and relaunch an app on the simulator by bundle ID.
Use when you need a clean app state without a full reinstall — for example after JS-only code changes, to reset in-memory state, or to reproduce a cold-start scenario.

Parameters: udid — simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890); bundleId — the app's bundle ID (e.g. com.example.MyApp).
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "bundleId": "com.example.MyApp" }
Returns { restarted: true, bundleId }. If the app is not running the terminate step is silently skipped. Fails if the app is not installed — call reinstall-app first.`,
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
