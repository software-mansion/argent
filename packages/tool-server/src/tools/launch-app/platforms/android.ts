import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, shellQuote, isAndroidTv } from "../../../utils/adb";
import type { LaunchAppParams, LaunchAppResult } from "../types";

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

// Parse the last `pkg/Activity` component out of `resolve-activity --brief`
// output (one component per line; the resolved activity is the last non-empty
// line). Returns null when the output names no concrete component — e.g. the
// package has no activity for the requested category.
function parseResolvedActivity(raw: string): string | null {
  const last = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  // Return null (not throw) when no concrete component resolves, so the TV
  // LEANBACK_LAUNCHER attempt can fall through to the standard LAUNCHER in
  // resolveLauncherActivity. That function throws (with the resolve-activity
  // output) only after every category has been tried.
  return last && /^[\w.]+\/[\w.$]+$/.test(last) ? last : null;
}

// Resolve the package's launcher activity via `cmd package resolve-activity`.
// `--brief` prints one component per line; the resolved activity is the last
// non-empty line (`pkg/fully.Qualified.Activity`). This lets the default
// (no-activity) branch use `am start -W` for a proper blocking launch.
//
// `isTv` switches the intent category from LAUNCHER to LEANBACK_LAUNCHER:
// Android TV apps declare a leanback launcher activity and frequently have NO
// phone-style LAUNCHER one, so a plain resolve returns the system resolver
// (`android/...ResolverActivity`) or nothing. We try LEANBACK first on TV and
// fall back to the standard LAUNCHER so apps that ship both still launch.
export async function resolveLauncherActivity(
  udid: string,
  bundleId: string,
  isTv = false
): Promise<string> {
  const resolveFor = async (category?: string): Promise<string | null> => {
    const intent = category ? ` -c ${shellQuote(category)}` : "";
    const raw = await adbShell(
      udid,
      `cmd package resolve-activity --brief${intent} ${shellQuote(bundleId)}`,
      { timeoutMs: 10_000 }
    );
    return parseResolvedActivity(raw);
  };

  if (isTv) {
    const leanback = await resolveFor("android.intent.category.LEANBACK_LAUNCHER");
    if (leanback) return leanback;
  }
  const launcher = await resolveFor();
  if (launcher) return launcher;

  throw new FailureError(
    `Could not resolve a ${isTv ? "LEANBACK_LAUNCHER or LAUNCHER" : "LAUNCHER"} activity for ${bundleId}. ` +
      `Install the app first, or pass an explicit \`activity\`.`,
    {
      error_code: FAILURE_CODES.ANDROID_LAUNCH_ACTIVITY_RESOLVE_FAILED,
      failure_stage: "android_launch_resolve_activity",
      failure_area: "tool_server",
      error_kind: "subprocess",
    }
  );
}

export const androidImpl: PlatformImpl<
  Record<string, unknown>,
  LaunchAppParams,
  LaunchAppResult
> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    // Resolve a concrete pkg/Activity component for every code path so we
    // can always use `am start -W`, which blocks until the activity is
    // drawn. The previous `monkey … LAUNCHER 1` fallback returned as soon
    // as the intent was injected, leaving a window where describe/tap
    // could race a still-forking process.
    let component: string;
    if (params.activity) {
      // Three accepted shapes:
      //   ".MainActivity"            → ${pkg}/.MainActivity (relative)
      //   "pkg/.X" or "pkg/full.X"   → use as-is
      //   "com.fully.Qualified"      → ${pkg}/com.fully.Qualified (FQCN)
      // A bare class name like "MainActivity" (no dot, no slash) used to be
      // emitted as `${pkg}/MainActivity`, which `am start` rejects because
      // an unqualified class is treated as default-package — i.e. no match.
      // Resolve the obvious intent by treating it as relative-to-bundleId.
      const a = params.activity;
      if (a.includes("/")) {
        component = a;
      } else if (a.startsWith(".")) {
        component = `${params.bundleId}/${a}`;
      } else if (a.includes(".")) {
        component = `${params.bundleId}/${a}`;
      } else {
        component = `${params.bundleId}/.${a}`;
      }
    } else {
      // Android TV apps declare a LEANBACK_LAUNCHER activity (often with no
      // phone LAUNCHER), so resolve against that category on TV targets.
      const isTv = await isAndroidTv(params.udid);
      component = await resolveLauncherActivity(params.udid, params.bundleId, isTv);
    }
    const out = await adbShell(params.udid, `am start -W -n ${shellQuote(component)}`, {
      timeoutMs: 30_000,
    });
    assertAmStartOk(out);
    return { launched: true, bundleId: params.bundleId };
  },
};
