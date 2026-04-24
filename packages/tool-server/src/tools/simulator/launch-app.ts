import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { classifyDevice } from "../../utils/platform-detect";
import { ensureDep } from "../../utils/check-deps";
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

// `am start -W` always prints a `Status:` banner. A positive-match check on
// `Status: ok` is more robust than scanning for keywords like "Error": the old
// /Error|Exception/ matcher false-failed on benign class names such as
// `com.example.ErrorReportingActivity` in the "Activity:" line, and
// false-succeeded on `Status: null` when the activity failed in onCreate.
function assertAmStartOk(out: string): void {
  if (!/Status:\s*ok/i.test(out)) {
    throw new Error(`am start failed: ${out.trim()}`);
  }
  // "Warning: Activity not started, its current task has been brought to the
  // front" also comes with Status: ok and means the app is foregrounded.
  // That's the behavior callers want from launch-app, so we don't reject it.
}

// Resolve the package's LAUNCHER activity via `cmd package resolve-activity`.
// Output of `--brief` is one component per line; the last non-empty line is
// `pkg/fully.Qualified.Activity`. This lets the default (no-activity) branch
// use `am start -W` for a proper blocking launch instead of `monkey 1`.
async function resolveLauncherActivity(udid: string, bundleId: string): Promise<string> {
  const raw = await adbShell(udid, `cmd package resolve-activity --brief ${bundleId}`, {
    timeoutMs: 10_000,
  });
  const last = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!last || !/^[\w.]+\/[\w.$]+$/.test(last)) {
    throw new Error(
      `Could not resolve a LAUNCHER activity for ${bundleId}. ` +
        `Install the app first, or pass an explicit \`activity\`. ` +
        `(resolve-activity output: ${raw.trim() || "empty"})`
    );
  }
  return last;
}

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
    alwaysLoad: true,
    searchHint: "open start app bundle id package simulator emulator launch",
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      // Defense-in-depth: re-run schema validation. Most callers go through
      // HTTP → zod, but internal paths like flow-run / flow-add-step invoke
      // tools without schema parsing, so an injected bundleId could otherwise
      // reach the adb-shell template below.
      params = zodSchema.parse(params);
      if ((await classifyDevice(params.udid)) === "android") {
        await ensureDep("adb");
        // Resolve a concrete pkg/Activity component for every code path so we
        // can always use `am start -W`, which blocks until the activity is
        // drawn. The previous `monkey … LAUNCHER 1` fallback returned as soon
        // as the intent was injected, leaving a window where describe/tap
        // could race a still-forking process.
        let component: string;
        if (params.activity) {
          component = params.activity.startsWith(".")
            ? `${params.bundleId}/${params.activity}`
            : params.activity.includes("/")
              ? params.activity
              : `${params.bundleId}/${params.activity}`;
        } else {
          component = await resolveLauncherActivity(params.udid, params.bundleId);
        }
        const out = await adbShell(params.udid, `am start -W -n ${component}`, {
          timeoutMs: 30_000,
        });
        assertAmStartOk(out);
        return { launched: true, bundleId: params.bundleId };
      }
      await ensureDep("xcrun");
      const api = await registry.resolveService<NativeDevtoolsApi>(
        `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`
      );
      await api.ensureEnvReady();
      await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
      return { launched: true, bundleId: params.bundleId };
    },
  };
}
