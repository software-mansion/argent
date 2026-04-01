import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("App bundle identifier (e.g. com.apple.MobileSMS)"),
});

export const launchAppTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { launched: boolean; bundleId: string }
> = {
  id: "launch-app",
  description: `Start an app on the simulator by bundle ID. Prefer this over tapping home-screen icons — it is instant and reliable.
Use when starting any app session, switching to a different app, or after reinstall/restart to bring the app to the foreground.

Parameters: udid — simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890); bundleId — the app's bundle identifier.
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "bundleId": "com.apple.mobilesafari" }
Common IDs: com.apple.MobileSMS (Messages), com.apple.Preferences (Settings), com.apple.Maps.
Returns { launched: true, bundleId }. Fails if the app is not installed — call reinstall-app first.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
    return { launched: true, bundleId: params.bundleId };
  },
};
