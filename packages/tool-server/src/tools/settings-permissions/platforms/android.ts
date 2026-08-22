import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, isTerminalAdbError, shellQuote } from "../../../utils/adb";
import type {
  PermissionAction,
  PermissionName,
  SettingsPermissionsParams,
  SettingsPermissionsResult,
  SettingsPermissionsServices,
} from "../types";

// Tool permission → the `android.permission.*` runtime permissions it covers.
// One entry fans out because Android splits what iOS models as a single service
// and because the concrete set shifted across API levels (READ_EXTERNAL_STORAGE
// pre-33 vs READ_MEDIA_* on 33+); the handler applies the action to every entry
// and succeeds if at least one sticks.
//
// READ_MEDIA_VISUAL_USER_SELECTED (API 34+) is what the "select photos"
// partial-access dialog grants persistently: without it `deny photos` would
// report success while the app still passes its partial-access check, and
// `reset photos` would land in "keep/select more" instead of the first-run
// dialog. Below API 34 `pm` rejects it and it lands in `skipped`.
//
// `reminders` is empty so the handler raises an unsupported error instead of
// silently no-opping: iOS Reminders (EventKit) has no Android equivalent.
const ANDROID_PERMISSIONS: Record<PermissionName, string[]> = {
  "camera": ["android.permission.CAMERA"],
  "microphone": ["android.permission.RECORD_AUDIO"],
  "photos": [
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
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

// `location-always` is the one action-dependent case: iOS grants full
// always-access, but ACCESS_BACKGROUND_LOCATION alone leaves the app unable to
// read location at all, so a grant fans out to foreground + background.
// deny/reset stay background-only — dropping "always" shouldn't also strip
// "while in use".
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

// A pm call fails two ways: pm ran and refused the permission (a manifest-style
// rejection, which belongs in `skipped`), or the transport died / timed out, so
// the call never ran and every remaining one is unreliable — that must reach the
// caller with adb's own cause, not be relabelled as a manifest gap.
//
// `isTerminalAdbError` covers the device-state shapes; these patterns cover the
// client↔daemon leg (`protocol fault ... Connection reset by peer` from the
// shared adb server restarting mid-command, `cannot connect to daemon` from it
// being down). They are matched here rather than in `isTerminalAdbError` because
// that predicate also gates `waitForBootCompleted`, where a reconnecting daemon
// mid-boot is a transient it deliberately swallows and retries.
const ADB_DAEMON_TRANSPORT_PATTERNS: RegExp[] = [
  /connection reset by peer/i,
  /cannot connect to daemon/i,
  /protocol fault/i,
];

function isTransportFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    isTerminalAdbError(message) ||
    ADB_DAEMON_TRANSPORT_PATTERNS.some((pattern) => pattern.test(message)) ||
    getFailureSignal(err)?.error_kind === "timeout"
  );
}

// pm errors arrive as a Java exception followed by a dozen `at com.android...`
// stack frames; only the exception line ("Package X has not requested
// permission Y") is actionable.
function stripStackFrames(detail: string): string {
  return detail
    .split("\n")
    .filter((line) => line.trim() && !/^\s*at\s/.test(line))
    .join(" ")
    .slice(0, 500);
}

// pm's mutating subcommands are silent on success, so output that isn't a
// `Success` line (SecurityException, "Unknown permission", usage text after a
// bad argument) is the failure description even on builds where the exit code
// stays 0.
async function runPm(udid: string, pmArgs: string): Promise<PmResult> {
  try {
    const out = await adbShell(udid, `pm ${pmArgs}`, { timeoutMs: 15_000 });
    const trimmed = out.trim();
    if (trimmed && !/^Success/i.test(trimmed)) {
      return { ok: false, detail: stripStackFrames(trimmed) };
    }
    return { ok: true, detail: trimmed };
  } catch (err) {
    // Not a pm rejection — propagate adbShell's classified FailureError so a
    // dead or wedged device surfaces its real cause, not a bogus "manifest gap".
    if (isTransportFailure(err)) throw err;
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

    // `pm grant`/`pm revoke` exit 0 when the package is not installed (observed
    // on API 34 and 36), so a typo'd bundleId would report a false success.
    // `pm list packages <pkg>` exits 0 either way and prints a `package:<name>`
    // line only when installed — so a successful run answers the question, and
    // any *throw* here is a transport / timeout / package-manager-not-up
    // failure that must propagate, never a "not installed" verdict.
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
        // reset = revoke, then a best-effort drop of the user-set/user-fixed
        // flags so the next request shows the dialog again. Only the revoke
        // decides success: `clear-permission-flags` first appears in Android 13
        // (API 33) and an unknown pm subcommand exits non-zero, so coupling
        // reset to it would fail every reset below API 33 — and it cannot undo
        // the revoke anyway. Hence its outcome, including a transport throw, is
        // ignored. Below API 33 reset therefore clears the grant but not a
        // user-fixed "don't ask again"; that ceiling is the platform's.
        result = await runPm(udid, `revoke ${pkg} ${perm}`);
        if (result.ok) {
          await runPm(udid, `clear-permission-flags ${pkg} ${perm} user-set user-fixed`).catch(
            () => {}
          );
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
    // The preflight above already proved the package is installed, so the error
    // leans on pm's own per-permission detail for the cause.
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
