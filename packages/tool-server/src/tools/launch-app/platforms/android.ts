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

  return (
    "The app took longer than Android's launch wait window to settle, so the launch was confirmed " +
    "by checking that the app's process is running. It is up but may still be on a splash or " +
    "loading screen — wait for the expected UI or take a screenshot before interacting."
  );
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
    const note = await assertAmStartLaunched(params.udid, component, out);
    return { launched: true, bundleId: params.bundleId, ...(note ? { note } : {}) };
  },
};
