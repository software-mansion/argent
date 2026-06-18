import { adbShell } from "../adb";

const DETECT_TIMEOUT_MS = 10_000;

/**
 * Auto-detect the foreground app on an Android device. Mirrors the iOS
 * `detectRunningApp` contract in semantics: returns a single package name, or
 * fails fast with an actionable message when zero or multiple user apps match.
 *
 * Strategy:
 *   1. `dumpsys activity activities` → parse ResumedActivity / topResumedActivity
 *      lines for the foreground package.
 *   2. Cross-check against `pm list packages -3` (user-installed apps only) so
 *      a system overlay (launcher, system UI) cannot masquerade as the target.
 */
export async function detectAndroidRunningApp(serial: string): Promise<string> {
  let activitiesOut: string;
  try {
    activitiesOut = await adbShell(serial, "dumpsys activity activities", {
      timeoutMs: DETECT_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to enumerate running activities on ${serial} within ${DETECT_TIMEOUT_MS} ms. ` +
        `Verify the device is booted and responsive, then retry. Underlying error: ${msg}`,
      { cause: err }
    );
  }

  const candidates = extractResumedPackages(activitiesOut);
  if (candidates.size === 0) {
    throw new Error(
      "No foreground app detected via `dumpsys activity activities`. " +
        "Launch the app first using `launch-app`, then retry."
    );
  }

  let userPackagesOut: string;
  try {
    userPackagesOut = await adbShell(serial, "pm list packages -3", {
      timeoutMs: DETECT_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to list user-installed packages on ${serial} within ${DETECT_TIMEOUT_MS} ms. ` +
        `Underlying error: ${msg}`,
      { cause: err }
    );
  }

  const userPackages = parseUserPackages(userPackagesOut);
  const userResumed = [...candidates].filter((pkg) => userPackages.has(pkg));

  if (userResumed.length === 0) {
    throw new Error(
      `Foreground activity belongs to a system package, not a user app. Resumed candidates were: [${[...candidates].join(", ")}]. ` +
        `Launch your app via \`launch-app\`, then retry.`
    );
  }
  if (userResumed.length > 1) {
    throw new Error(
      `Multiple user apps are in the foreground:\n  - ${userResumed.join("\n  - ")}\n` +
        `Specify \`app_process\` with the package name you want to profile.`
    );
  }
  return userResumed[0]!;
}

/**
 * Extract the resumed/top-resumed package name(s) from `dumpsys activity activities`
 * output. The relevant lines look like:
 *
 *   ResumedActivity: ActivityRecord{... com.example.app/.MainActivity ...}
 *   topResumedActivity=ActivityRecord{... com.example.app/.MainActivity ...}
 *   mResumedActivity: ActivityRecord{... u0 com.example.app/.MainActivity ...}
 *
 * We extract the `pkg/Activity` slug, then drop the `/Activity` half.
 */
export function extractResumedPackages(output: string): Set<string> {
  const result = new Set<string>();
  const lineRe =
    /(?:ResumedActivity|topResumedActivity|mResumedActivity)[^A-Za-z0-9._]*?ActivityRecord\{[^}]*?\s([A-Za-z_][\w.]*)\/[\w.$]+/g;
  let m;
  while ((m = lineRe.exec(output)) !== null) {
    result.add(m[1]!);
  }
  return result;
}

/**
 * Parse the `pm list packages -3` output into a Set. The output is one line
 * per user-installed package in the shape `package:com.example.app`.
 */
export function parseUserPackages(output: string): Set<string> {
  const result = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("package:")) continue;
    const pkg = line.slice("package:".length).trim();
    if (pkg) result.add(pkg);
  }
  return result;
}
