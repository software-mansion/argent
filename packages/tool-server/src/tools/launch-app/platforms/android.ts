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

// Normalize a user-supplied `activity` into a concrete `pkg/Activity` component
// for `am start -n`. Three accepted shapes plus the bare-name trap:
//   "pkg/.X" or "pkg/full.X"   → already a component, use as-is
//   ".MainActivity"            → ${pkg}/.MainActivity (relative)
//   "com.fully.Qualified"      → ${pkg}/com.fully.Qualified (FQCN)
//   "MainActivity"             → ${pkg}/.MainActivity
// The bare class name (no dot, no slash) is the trap: emitting it verbatim as
// `${pkg}/MainActivity` makes `am start` treat it as a default-package class and
// reject it ("no match"), so it must be made relative. Shared by launch-app and
// restart-app so the two can't drift on this.
export function normalizeActivityComponent(bundleId: string, activity: string): string {
  if (activity.includes("/")) return activity;
  if (activity.startsWith(".")) return `${bundleId}/${activity}`;
  if (activity.includes(".")) return `${bundleId}/${activity}`;
  return `${bundleId}/.${activity}`;
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
  if (!last || !/^[\w.]+\/[\w.$]+$/.test(last)) return null;
  // The Android system chooser/resolver (`android/...ResolverActivity` or its
  // `...ChooserActivity` sibling, returned when several launchers match) shares
  // the component shape but is NOT the app's launcher — `resolve-activity`
  // returns it when the package has no activity for the requested category
  // (common on TV, where a leanback-only app has no phone LAUNCHER). Treat it as
  // "not resolved" so the LEANBACK→LAUNCHER fallback continues instead of
  // launching the system chooser and reporting a false success. Anchored to the
  // `android/` system package so a real app activity that merely ends in
  // "ResolverActivity" (e.g. `com.example/.ResolverActivity`) is not rejected.
  if (/^android\/.*(Resolver|Chooser)Activity$/.test(last)) return null;
  return last;
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
  // Keep the raw output of the last attempt so the failure message can surface
  // what adb actually returned — the diagnostic that distinguishes "empty
  // output" (app not installed) from "wrong component shape" (only the system
  // ResolverActivity matched).
  let lastRaw = "";
  const resolveFor = async (category?: string): Promise<string | null> => {
    const intent = category ? ` -c ${shellQuote(category)}` : "";
    const raw = await adbShell(
      udid,
      `cmd package resolve-activity --brief${intent} ${shellQuote(bundleId)}`,
      { timeoutMs: 10_000 }
    );
    lastRaw = raw;
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
      `Install the app first, or pass an explicit \`activity\`. ` +
      `(resolve-activity output: ${lastRaw.trim() || "empty"})`,
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
      component = normalizeActivityComponent(params.bundleId, params.activity);
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
