import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { adbShell } from "../../utils/adb";
import { detectPlatform } from "../../utils/platform-detect";

const zodSchema = z.object({
  udid: z.string().describe("Android adb serial (e.g. `emulator-5554`)."),
  bundleId: z.string().describe("Android package name to force-stop."),
});

export const androidStopAppTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { stopped: boolean; bundleId: string }
> = {
  id: "android-stop-app",
  description:
    "Force-stop an Android app without relaunching it. Android-only — no iOS equivalent (use `restart-app` for iOS). " +
    "Returns { stopped, bundleId }. Does not error if the app was not running.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    if (detectPlatform(params.udid) !== "android") {
      throw new Error(
        "android-stop-app is Android-only. For iOS use `restart-app` (terminate + relaunch)."
      );
    }
    await adbShell(params.udid, `am force-stop ${params.bundleId}`, { timeoutMs: 15_000 });
    return { stopped: true, bundleId: params.bundleId };
  },
};
