import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { classifyDevice } from "../../utils/platform-detect";
import { adbShell } from "../../utils/adb";

const execFileAsync = promisify(execFile);

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .min(1)
    .regex(BUNDLE_ID_PATTERN, "bundleId may only contain letters, digits, '.', '_' and '-'")
    .describe("App identifier. iOS: bundle id. Android: package name."),
});

type RestartAppParams = z.infer<typeof zodSchema>;

export function createRestartAppTool(
  registry: Registry
): ToolDefinition<RestartAppParams, { restarted: boolean; bundleId: string }> {
  return {
    id: "restart-app",
    description: `Terminate then relaunch an app by bundle id / package name.
Use when you need a clean in-memory state without a full reinstall. Also refreshes the native-devtools injection on iOS before the relaunch.
Returns { restarted, bundleId }. Fails if the app is not installed.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      // Defense-in-depth: re-run schema validation (flow-run invokes tools
      // without per-tool zod parsing, so an injected bundleId could slip past).
      params = zodSchema.parse(params);
      const { udid, bundleId } = params;
      if ((await classifyDevice(udid)) === "android") {
        await adbShell(udid, `am force-stop ${bundleId}`, { timeoutMs: 15_000 });
        const out = await adbShell(
          udid,
          `monkey -p ${bundleId} -c android.intent.category.LAUNCHER 1`,
          { timeoutMs: 30_000 }
        );
        if (/No activities found|Error:/i.test(out)) {
          throw new Error(`relaunch failed: ${out.trim()}`);
        }
        return { restarted: true, bundleId };
      }
      const api = await registry.resolveService<NativeDevtoolsApi>(
        `${NATIVE_DEVTOOLS_NAMESPACE}:${udid}`
      );
      await api.ensureEnvReady();
      try {
        await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId]);
      } catch {
        // App may not be running — ignore
      }
      await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId]);
      return { restarted: true, bundleId };
    },
  };
}
