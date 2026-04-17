import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ServiceRef, ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { detectPlatform } from "../../utils/platform-detect";
import { adbShell } from "../../utils/adb";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Device id. For iOS: simulator UDID (UUID shape). For Android: adb serial (e.g. `emulator-5554`)."
    ),
  bundleId: z.string().describe("App identifier. iOS: bundle id. Android: package name."),
});

export const restartAppTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { restarted: boolean; bundleId: string }
> = {
  id: "restart-app",
  description: `Restart an app by terminating then relaunching it.
iOS: \`xcrun simctl terminate\` + launch; refreshes native-devtools injection.
Android: \`am force-stop\` + \`monkey\` launcher intent.
Use when you need a clean in-memory state without a full reinstall. Returns { restarted, bundleId }. Fails if the app is not installed.`,
  zodSchema,
  services: (params): Record<string, ServiceRef> =>
    detectPlatform(params.udid) === "ios"
      ? { nativeDevtools: `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}` }
      : {},
  async execute(services, params) {
    const { udid, bundleId } = params;
    if (detectPlatform(udid) === "android") {
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
    const api = services.nativeDevtools as NativeDevtoolsApi;
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
