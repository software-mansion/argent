import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, shellQuote } from "../../../utils/adb";
import type { LaunchAppAndroidServices, LaunchAppParams, LaunchAppResult } from "../types";

// `am start -W` always prints a `Status:` banner. A positive-match check on
// `Status: ok` is more robust than scanning for keywords like "Error": the old
// /Error|Exception/ matcher false-failed on benign class names such as
// `com.example.ErrorReportingActivity` in the "Activity:" line, and
// false-succeeded on `Status: null` when the activity failed in onCreate.
export function assertAmStartOk(out: string): void {
  if (!/Status:\s*ok/i.test(out)) {
    throw new FailureError(`am start failed: ${out.trim()}`, {
      error_code: FAILURE_CODES.ANDROID_LAUNCH_AM_START_FAILED,
      failure_stage: "android_launch_am_start",
      failure_area: "tool_server",
      error_kind: "subprocess",
    });
  }
  // "Warning: Activity not started, its current task has been brought to the
  // front" also comes with Status: ok and means the app is foregrounded.
  // That's the behavior callers want from launch-app, so we don't reject it.
}

// Resolve the package's LAUNCHER activity via `cmd package resolve-activity`.
// Output of `--brief` is one component per line; the last non-empty line is
// `pkg/fully.Qualified.Activity`. This lets the default (no-activity) branch
// use `am start -W` for a proper blocking launch instead of `monkey 1`.
export async function resolveLauncherActivity(udid: string, bundleId: string): Promise<string> {
  const raw = await adbShell(udid, `cmd package resolve-activity --brief ${shellQuote(bundleId)}`, {
    timeoutMs: 10_000,
  });
  const last = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!last || !/^[\w.]+\/[\w.$]+$/.test(last)) {
    throw new FailureError(
      `Could not resolve a LAUNCHER activity for ${bundleId}. ` +
        `Install the app first, or pass an explicit \`activity\`. ` +
        `(resolve-activity output: ${raw.trim() || "empty"})`,
      {
        error_code: FAILURE_CODES.ANDROID_LAUNCH_ACTIVITY_RESOLVE_FAILED,
        failure_stage: "android_launch_resolve_activity",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  }
  return last;
}

// Normalize an `activity` param into a `pkg/Activity` component for `am start -n`.
// Four accepted shapes:
//   "pkg/.X" or "pkg/full.X"   → use as-is (already a component)
//   ".MainActivity"            → ${pkg}/.MainActivity (relative)
//   "com.fully.Qualified"      → ${pkg}/com.fully.Qualified (FQCN)
//   "MainActivity"             → ${pkg}/.MainActivity (bare class name)
// A bare class name (no dot, no slash) must be dot-prefixed: `${pkg}/MainActivity`
// is rejected by `am start` because an unqualified class is treated as
// default-package — i.e. no match.
export function buildActivityComponent(bundleId: string, activity: string): string {
  if (activity.includes("/")) return activity;
  if (activity.startsWith(".")) return `${bundleId}/${activity}`;
  if (activity.includes(".")) return `${bundleId}/${activity}`;
  return `${bundleId}/.${activity}`;
}

export const androidImpl: PlatformImpl<LaunchAppAndroidServices, LaunchAppParams, LaunchAppResult> =
  {
    requires: ["adb"],
    handler: async (_services, params) => {
      // Resolve a concrete pkg/Activity component for every code path so we
      // can always use `am start -W`, which blocks until the activity is
      // drawn. The previous `monkey … LAUNCHER 1` fallback returned as soon
      // as the intent was injected, leaving a window where describe/tap
      // could race a still-forking process.
      let component: string;
      if (params.activity) {
        component = buildActivityComponent(params.bundleId, params.activity);
      } else {
        component = await resolveLauncherActivity(params.udid, params.bundleId);
      }
      const out = await adbShell(params.udid, `am start -W -n ${shellQuote(component)}`, {
        timeoutMs: 30_000,
      });
      assertAmStartOk(out);
      return { launched: true, bundleId: params.bundleId };
    },
  };
