import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, shellQuote, isAndroidTv, ensureMetroReverse } from "../../../utils/adb";
import type { LaunchAppParams, LaunchAppResult } from "../types";

// `am start -W` always prints a `Status:` banner, so a positive match on
// `Status: ok` beats scanning for keywords like "Error": those false-fail on
// benign class names (`com.example.ErrorReportingActivity` in the `Activity:`
// line) and false-succeed on `Status: null` when the activity dies in onCreate.
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
  // front" also comes with Status: ok, and foregrounding is what callers want.
}

// Normalize a user-supplied `activity` into a `pkg/Activity` component for
// `am start -n`. A bare class name must be made relative (`${pkg}/.MainActivity`):
// `${pkg}/MainActivity` is read as a default-package class and rejected with
// "no match". Shared with restart-app so the two can't drift.
export function normalizeActivityComponent(bundleId: string, activity: string): string {
  if (activity.includes("/")) return activity;
  if (activity.startsWith(".")) return `${bundleId}/${activity}`;
  if (activity.includes(".")) return `${bundleId}/${activity}`;
  return `${bundleId}/.${activity}`;
}

// The resolved component is the last non-empty line of `resolve-activity
// --brief` output; null when no line names a concrete component.
function parseResolvedActivity(raw: string): string | null {
  const last = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  // null rather than throw, so a TV LEANBACK attempt can fall through to the
  // plain LAUNCHER in resolveLauncherActivity, which throws only after both fail.
  if (!last || !/^[\w.]+\/[\w.$]+$/.test(last)) return null;
  // `resolve-activity` returns the system chooser (`android/...Resolver` or
  // `...ChooserActivity`) when the package has no activity for the requested
  // category (common for leanback-only apps); it matches the component shape but
  // is not the app's launcher. Treat it as unresolved so the fallback continues
  // instead of launching the chooser and reporting success. Anchored to the
  // `android/` system package so an app's own `.ResolverActivity` still passes.
  if (/^android\/.*(Resolver|Chooser)Activity$/.test(last)) return null;
  return last;
}

// `isTv` resolves against LEANBACK_LAUNCHER first: Android TV apps often declare
// no phone LAUNCHER, so a plain resolve returns the system resolver or nothing.
// Falls back to the standard LAUNCHER so apps shipping both still launch.
export async function resolveLauncherActivity(
  udid: string,
  bundleId: string,
  isTv = false
): Promise<string> {
  // Surfaced in the failure message: distinguishes empty output (app not
  // installed) from a wrong component shape (only the system resolver matched).
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
    // Before the process starts, not after: an RN app reads Metro at startup,
    // so a reverse asserted later is a reverse the app already missed.
    await ensureMetroReverse(params.udid);
    // Resolve a concrete component on every path so the launch can use
    // `am start -W`, which blocks until the activity is drawn; otherwise
    // describe/tap can race a still-forking process.
    let component: string;
    if (params.activity) {
      component = normalizeActivityComponent(params.bundleId, params.activity);
    } else {
      // TV apps often declare only a LEANBACK_LAUNCHER activity.
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
