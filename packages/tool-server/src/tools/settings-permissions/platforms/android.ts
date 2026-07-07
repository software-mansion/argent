import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, shellQuote } from "../../../utils/adb";
import type {
  PermissionAction,
  PermissionName,
  SettingsPermissionsParams,
  SettingsPermissionsResult,
  SettingsPermissionsServices,
} from "../types";

// Tool permission → the `android.permission.*` runtime permissions it covers.
// One abstract permission fans out to several concrete ones because Android
// splits what iOS models as a single service (fine/coarse location, per-media
// read permissions) and because the concrete set shifted across API levels
// (READ_EXTERNAL_STORAGE pre-33 vs READ_MEDIA_* on 33+). The handler applies
// the action to every entry and succeeds if at least one sticks — which entry
// exists depends on the app's manifest and the device's API level, and `pm`
// itself is the authority on that.
//
// `reminders` is empty: iOS Reminders (EventKit) has no Android runtime
// permission, so it surfaces an unsupported error rather than silently
// no-opping.
const ANDROID_PERMISSIONS: Record<PermissionName, string[]> = {
  "camera": ["android.permission.CAMERA"],
  "microphone": ["android.permission.RECORD_AUDIO"],
  "photos": [
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.READ_EXTERNAL_STORAGE",
  ],
  "contacts": ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
  "notifications": ["android.permission.POST_NOTIFICATIONS"],
  "calendar": ["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"],
  "location": [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
  ],
  "location-always": ["android.permission.ACCESS_BACKGROUND_LOCATION"],
  "media-library": [
    "android.permission.READ_MEDIA_AUDIO",
    "android.permission.READ_EXTERNAL_STORAGE",
  ],
  "motion": ["android.permission.ACTIVITY_RECOGNITION"],
  "reminders": [],
};

// Resolve the concrete permission list for a (permission, action) pair.
// `location-always` is the one action-dependent case: granting
// ACCESS_BACKGROUND_LOCATION alone leaves the app unable to read location at
// all (Android requires the foreground permissions too), while iOS's
// `location-always` grants full always-access — so a grant fans out to
// foreground + background to match the caller's intent. deny/reset stay
// background-only: taking away "always" shouldn't also strip "while in use".
function permissionsFor(permission: PermissionName, action: PermissionAction): string[] {
  if (permission === "location-always" && action === "grant") {
    return [...ANDROID_PERMISSIONS.location, ...ANDROID_PERMISSIONS["location-always"]];
  }
  return ANDROID_PERMISSIONS[permission];
}

interface PmResult {
  ok: boolean;
  detail: string;
}

// pm errors arrive as a Java exception followed by a dozen `at com.android...`
// stack frames. Only the exception line says anything actionable ("Package X
// has not requested permission Y"); drop the frames so the surfaced error and
// telemetry stay readable.
function stripStackFrames(detail: string): string {
  return detail
    .split("\n")
    .filter((line) => line.trim() && !/^\s*at\s/.test(line))
    .join(" ")
    .slice(0, 500);
}

// Run one `pm <args>` and classify the outcome. pm's mutating subcommands
// (grant / revoke / clear-permission-flags) are silent on success; any output
// (SecurityException, "Unknown permission", usage text after a bad argument)
// is a failure description even on builds where the exit code stays 0. A
// non-zero exit throws from runAdb and is captured the same way.
async function runPm(udid: string, pmArgs: string): Promise<PmResult> {
  try {
    const out = await adbShell(udid, `pm ${pmArgs}`, { timeoutMs: 15_000 });
    const trimmed = out.trim();
    if (trimmed && !/^Success/i.test(trimmed)) {
      return { ok: false, detail: stripStackFrames(trimmed) };
    }
    return { ok: true, detail: trimmed };
  } catch (err) {
    return {
      ok: false,
      detail: stripStackFrames(err instanceof Error ? err.message : String(err)),
    };
  }
}

export const androidImpl: PlatformImpl<
  SettingsPermissionsServices,
  SettingsPermissionsParams,
  SettingsPermissionsResult
> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, action, permission, bundleId } = params;

    const permissions = permissionsFor(permission, action);
    if (permissions.length === 0) {
      throw new FailureError(
        `Permission '${permission}' has no Android runtime-permission equivalent, so there is nothing to ${action}.`,
        {
          error_code: FAILURE_CODES.SETTINGS_PERMISSION_UNSUPPORTED,
          failure_stage: "android_settings_permission_map_permissions",
          failure_area: "tool_server",
          error_kind: "unsupported",
        }
      );
    }

    const pkg = shellQuote(bundleId);

    // `pm grant`/`pm revoke` silently exit 0 when the package is not installed
    // (observed on API 34 and API 36), so a typo'd bundleId would otherwise
    // report a false success. `pm list packages <pkg>` is the authoritative
    // existence probe: it exits 0 whether or not the package exists (verified on
    // API 36) and prints a `package:<name>` line only for installed packages.
    // Because a *successful* run answers both "installed" and "not installed"
    // (with vs without the line), any *thrown* error here is unambiguously a
    // transport / timeout / package-manager-not-yet-up failure — never a "not
    // installed" verdict. Let it propagate with adb's real cause rather than
    // catching it and reporting a confidently wrong "not installed" (the failure
    // mode of the old `pm path` probe, which exits non-zero for a missing
    // package and so could not tell the two apart).
    const listing = await adbShell(udid, `pm list packages ${pkg}`, { timeoutMs: 15_000 });
    const installed = listing.split("\n").some((line) => line.trim() === `package:${bundleId}`);
    if (!installed) {
      throw new FailureError(
        `Package ${bundleId} is not installed on ${udid} — install the app before changing its permissions.`,
        {
          error_code: FAILURE_CODES.ANDROID_SETTINGS_PERMISSION_FAILED,
          failure_stage: "android_settings_permission_package_missing",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    }

    const applied: string[] = [];
    const failures: Array<{ permission: string; detail: string }> = [];

    for (const perm of permissions) {
      let result: PmResult;
      if (action === "grant") {
        result = await runPm(udid, `grant ${pkg} ${perm}`);
      } else if (action === "deny") {
        result = await runPm(udid, `revoke ${pkg} ${perm}`);
      } else {
        // reset = `pm revoke`, then a best-effort attempt to drop the
        // user-set/user-fixed flags so the next request shows the dialog again.
        // The revoke is the state-changing step and alone decides success: it is
        // rejected only when pm genuinely refuses the permission (not declared /
        // not a changeable type) — the manifest-style failure the aggregate
        // error below describes. Clearing the flags is a refinement that must
        // never demote a permission the revoke already changed:
        //   - `clear-permission-flags` does not exist before Android 11 (it is an
        //     unknown pm subcommand there and exits non-zero), so coupling reset
        //     to it would make every reset on API < 30 falsely report failure;
        //   - and it cannot undo the revoke, so a flag-clear failure on a newer
        //     device still leaves the permission revoked, not "pm-rejected".
        // So we run it but ignore its outcome — `result` stays the revoke's.
        result = await runPm(udid, `revoke ${pkg} ${perm}`);
        if (result.ok) {
          await runPm(udid, `clear-permission-flags ${pkg} ${perm} user-set user-fixed`);
        }
      }
      if (result.ok) {
        applied.push(perm);
      } else {
        failures.push({ permission: perm, detail: result.detail });
      }
    }

    // Partial success is expected (which concrete permission exists depends on
    // manifest + API level), but zero successes means the action did nothing.
    // The package is already known-installed (the preflight above proved it), so
    // don't reassert that here — surface pm's own per-permission reasons, which
    // also carry any transport/timeout cause verbatim, so the caller sees the
    // real problem rather than a fixed manifest guess.
    if (applied.length === 0) {
      const details = failures.map((f) => `${f.permission}: ${f.detail}`).join("; ");
      throw new FailureError(
        `Failed to ${action} '${permission}' for ${bundleId} on ${udid} — every mapped runtime permission was rejected. ` +
          `Usually the manifest doesn't declare it, or it isn't a runtime-changeable permission; see the per-permission detail for the exact cause. (${details})`,
        {
          error_code: FAILURE_CODES.ANDROID_SETTINGS_PERMISSION_FAILED,
          failure_stage: "android_settings_permission_pm",
          failure_area: "tool_server",
          error_kind: "subprocess",
        }
      );
    }

    return {
      action,
      permission,
      bundleId,
      applied,
      ...(failures.length > 0 ? { skipped: failures.map((f) => f.permission) } : {}),
    };
  },
};
