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
  bundleId: z
    .string()
    .describe(
      "App identifier. iOS: bundle id (e.g. com.apple.MobileSMS). Android: package name (e.g. com.android.settings) — the `applicationId` from build.gradle."
    ),
  activity: z
    .string()
    .optional()
    .describe(
      "Android-only: optional fully-qualified Activity name (e.g. `.MainActivity` or `com.example/com.example.MainActivity`). " +
        "If omitted on Android, the default launcher activity is used via `monkey`. Ignored on iOS."
    ),
});

export const launchAppTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { launched: boolean; bundleId: string }
> = {
  id: "launch-app",
  description: `Open an app by bundle id (iOS) or package name (Android). Prefer this over tapping home-screen / launcher icons.

iOS: uses \`xcrun simctl launch\`; prepares native-devtools launch injection before the app starts.
Android: uses \`am start -n <pkg>/<activity>\` when \`activity\` is provided, otherwise sends a LAUNCHER intent via \`monkey\`.

Returns { launched, bundleId }. Fails if the app is not installed on the device.

Common iOS bundle ids: com.apple.MobileSMS, com.apple.mobilesafari, com.apple.Preferences, com.apple.Maps, com.apple.camera, com.apple.Photos, com.apple.mobilemail, com.apple.mobilenotes, com.apple.MobileAddressBook
Common Android packages: com.android.settings, com.android.chrome, com.google.android.apps.maps, com.google.android.gm, com.android.vending, com.google.android.dialer, com.google.android.apps.messaging`,
  zodSchema,
  services: (params): Record<string, ServiceRef> =>
    detectPlatform(params.udid) === "ios"
      ? { nativeDevtools: `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}` }
      : {},
  async execute(services, params) {
    if (detectPlatform(params.udid) === "android") {
      if (params.activity) {
        const component = params.activity.startsWith(".")
          ? `${params.bundleId}/${params.activity}`
          : params.activity.includes("/")
            ? params.activity
            : `${params.bundleId}/${params.activity}`;
        const out = await adbShell(params.udid, `am start -W -n ${component}`, {
          timeoutMs: 30_000,
        });
        if (/Error|Exception/i.test(out) && !/Status: ok/i.test(out)) {
          throw new Error(`am start failed: ${out.trim()}`);
        }
      } else {
        const out = await adbShell(
          params.udid,
          `monkey -p ${params.bundleId} -c android.intent.category.LAUNCHER 1`,
          { timeoutMs: 30_000 }
        );
        if (/No activities found|Error:/i.test(out)) {
          throw new Error(`monkey launch failed: ${out.trim()}`);
        }
      }
      return { launched: true, bundleId: params.bundleId };
    }
    const api = services.nativeDevtools as NativeDevtoolsApi;
    await api.ensureEnvReady();
    await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
    return { launched: true, bundleId: params.bundleId };
  },
};
