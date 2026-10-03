import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, shellQuote, isAndroidTv, isPackageProcessRunning } from "../../../utils/adb";
import type { LaunchAppParams, LaunchAppResult } from "../types";

/**
 * Did `am start -W` actually launch something?
 *
 * The banner is matched positively, against a closed set. A previous
 * `/Error|Exception/` scan false-failed on benign class names like
 * `com.example.ErrorReportingActivity` appearing in the `Activity:` line, so
 * keyword scanning must not come back. Anything unrecognised is rejected, which
 * covers every `Error:` shape for free — those print *instead of* the `Status:`
 * banner rather than alongside it.
 *
 * `Status:` is rendered from a boolean, so upstream Android can only ever emit
 * `ok` or `timeout`. (A `Status: null` shape is mentioned in this file's history
 * but has never been reproduced and is not reachable from that ternary; it is
 * rejected here simply by not being in the set.)
 *
 * Worth being accurate about what this does NOT catch: an activity destroyed
 * while the launch is still being waited on reports `timeout=false`, i.e.
 * `Status: ok`. So an app that crashes during startup is accepted today and
 * remains accepted — this check has never been the thing that caught it.
 */
export function classifyAmStartStatus(out: string): "ok" | "timeout" | "rejected" {
  // Line-anchored and `\w+`: an activity name containing "Status:" must not
  // match, and a CRLF stream must not smuggle a `\r` into the token.
  const status = /^\s*Status:\s*(\w+)/im.exec(out)?.[1]?.toLowerCase();
  if (status === "ok") return "ok";
  if (status === "timeout") return "timeout";
  return "rejected";
}

/**
 * `Status: timeout` is a latency verdict, not a failure one.
 *
 * It is set by a single path in the framework: the activity was resolved,
 * started and resumed, and then failed to report idle before the launch wait
 * window elapsed. It cannot be produced by an intent that failed to resolve or
 * was refused — those return before any waiting happens. A cold React Native
 * start routinely overruns that window while launching perfectly well, and
 * treating it as a failure made agents retry or "fix" a launch that had already
 * succeeded (#615).
 *
 * The `Activity:` line is not evidence to lean on here: both call sites launch
 * an explicit component, and on this path the framework fills that field from
 * the record being waited on — so it is close to our own input echoed back.
 * Whether the app is actually alive is asked directly instead, and only on this
 * branch, which by definition has already spent longer than the wait window.
 *
 * Returns a note when the launch was confirmed the slow way, so the caller knows
 * the app is up but may not be interactive yet.
 */
export async function assertAmStartLaunched(
  udid: string,
  component: string,
  out: string
): Promise<string | undefined> {
  const status = classifyAmStartStatus(out);
  if (status === "ok") return undefined;

  const fail = (message: string): never => {
    throw new FailureError(message, {
      error_code: FAILURE_CODES.ANDROID_LAUNCH_AM_START_FAILED,
      failure_stage: "android_launch_am_start",
      failure_area: "tool_server",
      error_kind: "subprocess",
    });
  };

  if (status === "rejected") fail(`am start failed: ${out.trim()}`);

  // Probe the package that was actually launched. `activity` may name a
  // different package than `bundleId` (the `pkg/Class` form is documented and
  // accepted), and asking about the wrong one could both miss a real launch and
  // accept a stale process from an earlier session.
  const launchedPkg = component.split("/")[0] ?? "";
  let running: boolean;
  try {
    running = await isPackageProcessRunning(udid, launchedPkg);
  } catch (err) {
    // An unanswerable probe is not evidence of a crash — say only what is known.
    return fail(
      `am start could not be confirmed: the launch wait window elapsed and checking whether ` +
        `${launchedPkg} is running failed (${err instanceof Error ? err.message : String(err)}). ` +
        `Output: ${out.trim()}`
    );
  }

  if (!running) {
    return fail(
      `am start failed: the launch wait window elapsed and no ${launchedPkg} process is running, ` +
        `so the app did not stay up. Output: ${out.trim()}`
    );
  }

  return "Launch overran Android's wait window but the app process is running; it may still be loading, so wait for the expected UI before interacting.";
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
    const note = await assertAmStartLaunched(params.udid, component, out);
    return { launched: true, bundleId: params.bundleId, ...(note ? { note } : {}) };
  },
};
