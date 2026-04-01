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
  description: `Open an app on the simulator by bundleId.
Prefer this over tapping home-screen icons — it is instant and reliable.
Use when you need to open an app at the start of a session or after restart, e.g. "com.apple.mobilesafari" to open Safari.
Accepts: udid, bundleId (e.g. "com.apple.mobilesafari"). Returns the launched bundle ID. Fails if the bundle ID is not installed on the simulator.

Common bundle IDs:
- Messages:  com.apple.MobileSMS
- Safari:    com.apple.mobilesafari
- Settings:  com.apple.Preferences
- Maps:      com.apple.Maps
- Camera:    com.apple.camera
- Photos:    com.apple.Photos
- Mail:      com.apple.mobilemail
- Notes:     com.apple.mobilenotes
- Clock:     com.apple.mobiletimer
- Calendar:  com.apple.mobilecal
- Contacts:  com.apple.MobileAddressBook`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
    return { launched: true, bundleId: params.bundleId };
  },
};
