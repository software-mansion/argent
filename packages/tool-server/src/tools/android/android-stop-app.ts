import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { adbShell } from "../../utils/adb";
import { classifyDevice } from "../../utils/platform-detect";

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const zodSchema = z.object({
  udid: z.string().min(1).describe("Android adb serial (e.g. `emulator-5554`)."),
  bundleId: z
    .string()
    .min(1)
    .regex(BUNDLE_ID_PATTERN, "bundleId may only contain letters, digits, '.', '_' and '-'")
    .describe("Android package name to force-stop."),
});

export const androidStopAppTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { stopped: boolean; bundleId: string }
> = {
  id: "android-stop-app",
  requires: ["adb"],
  description: `Stop a running Android app without relaunching it — force-stops the process and its background services.
Use when wiping runtime state, preparing a clean relaunch, or dismissing a backgrounded process. Android-only: for iOS, call restart-app instead (which terminates + relaunches in one step).
Returns { stopped, bundleId } with 'stopped' always true on success — Android does not distinguish "stopped a running app" from "was already not running".
Fails when the udid is not in list-devices (unknown device) or the device is offline; does not error if the target package is installed but idle.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    // Defense-in-depth: re-run schema validation so an injected bundleId via
    // flow-run or another non-HTTP caller cannot reach the adb-shell template.
    params = zodSchema.parse(params);
    if ((await classifyDevice(params.udid)) !== "android") {
      throw new Error(
        "android-stop-app is Android-only. For iOS use `restart-app` (terminate + relaunch)."
      );
    }
    await adbShell(params.udid, `am force-stop ${params.bundleId}`, { timeoutMs: 15_000 });
    return { stopped: true, bundleId: params.bundleId };
  },
};
