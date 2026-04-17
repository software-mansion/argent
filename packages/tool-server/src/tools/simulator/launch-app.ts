import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { classifyDevice } from "../../utils/platform-detect";
import { adbShell } from "../../utils/adb";

const execFileAsync = promisify(execFile);

// Android package grammar is `[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+`;
// iOS bundle ids use the same reverse-DNS shape with dashes allowed. The union
// of both platforms is letters, digits, underscore, dot, hyphen — and explicitly
// nothing else so shell metacharacters can't land in an `adb shell` template.
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
// Activity names can be `.Foo`, `com.x.y/.Foo`, or `com.x/com.x.Foo`. Same alphabet
// plus `/` as the package/activity separator. `$` and other shell metacharacters
// are deliberately excluded.
const ACTIVITY_PATTERN = /^[A-Za-z0-9._/-]+$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .min(1)
    .regex(BUNDLE_ID_PATTERN, "bundleId may only contain letters, digits, '.', '_' and '-'")
    .describe(
      "App identifier. iOS: bundle id (e.g. com.apple.MobileSMS). Android: package name from build.gradle `applicationId` (e.g. com.android.settings)."
    ),
  activity: z
    .string()
    .min(1)
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe(
      "Android-only: fully-qualified Activity name (e.g. `.MainActivity` or `com.example/com.example.MainActivity`). If omitted on Android, the app's default launcher activity is used. Ignored on iOS."
    ),
});

type LaunchAppParams = z.infer<typeof zodSchema>;

export function createLaunchAppTool(
  registry: Registry
): ToolDefinition<LaunchAppParams, { launched: boolean; bundleId: string }> {
  return {
    id: "launch-app",
    description: `Open an app by its bundle id (iOS) or package name (Android).
Use when starting any app — prefer this over tapping home-screen / launcher icons. Also prepares the native-devtools injection on iOS before the app starts.
Returns { launched, bundleId }. Fails if the app is not installed on the target device.

Common iOS bundle ids: com.apple.MobileSMS, com.apple.mobilesafari, com.apple.Preferences, com.apple.Maps, com.apple.camera, com.apple.Photos, com.apple.mobilemail, com.apple.mobilenotes, com.apple.MobileAddressBook
Common Android packages: com.android.settings, com.android.chrome, com.google.android.apps.maps, com.google.android.gm, com.android.vending, com.google.android.dialer, com.google.android.apps.messaging`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      // Defense-in-depth: re-run schema validation. Most callers go through
      // HTTP → zod, but internal paths like flow-run / flow-add-step invoke
      // tools without schema parsing, so an injected bundleId could otherwise
      // reach the adb-shell template below.
      params = zodSchema.parse(params);
      if ((await classifyDevice(params.udid)) === "android") {
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
      const api = await registry.resolveService<NativeDevtoolsApi>(
        `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`
      );
      await api.ensureEnvReady();
      await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
      return { launched: true, bundleId: params.bundleId };
    },
  };
}
