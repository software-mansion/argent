import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type {
  PermissionAction,
  PermissionName,
  SettingsPermissionsParams,
  SettingsPermissionsResult,
  SettingsPermissionsServices,
} from "../types";

const execFileAsync = promisify(execFile);

// Tool action → `simctl privacy` action. Only the deny/revoke name differs;
// the tool says "deny" because that's the vocabulary of the permission dialog
// the agent is replacing.
const SIMCTL_ACTION: Record<PermissionAction, "grant" | "revoke" | "reset"> = {
  grant: "grant",
  deny: "revoke",
  reset: "reset",
};

// Tool permission → `simctl privacy` service. Identity for everything simctl
// models, with two exceptions:
// - `notifications` has NO simctl privacy service (notification authorization
//   lives outside TCC), so it is null and surfaces a clear unsupported error.
// - `camera` is not listed by every Xcode's simctl (the simulator has no
//   camera hardware). It is passed through rather than pre-rejected so an
//   Xcode that does support it works; on one that doesn't, simctl's own
//   "invalid service" error is wrapped with a hint below.
const IOS_SERVICE: Record<PermissionName, string | null> = {
  "camera": "camera",
  "microphone": "microphone",
  "photos": "photos",
  "contacts": "contacts",
  "notifications": null,
  "calendar": "calendar",
  "location": "location",
  "location-always": "location-always",
  "media-library": "media-library",
  "motion": "motion",
  "reminders": "reminders",
};

export const iosImpl: PlatformImpl<
  SettingsPermissionsServices,
  SettingsPermissionsParams,
  SettingsPermissionsResult
> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    const { udid, action, permission, bundleId } = params;

    const service = IOS_SERVICE[permission];
    if (!service) {
      throw new FailureError(
        `Permission '${permission}' cannot be changed on the iOS simulator — ` +
          `\`xcrun simctl privacy\` has no service for it. ` +
          `Interact with the notification permission dialog in the app instead.`,
        {
          error_code: FAILURE_CODES.SETTINGS_PERMISSION_UNSUPPORTED,
          failure_stage: "ios_settings_permission_map_service",
          failure_area: "tool_server",
          error_kind: "unsupported",
        }
      );
    }

    const args = ["simctl", "privacy", udid, SIMCTL_ACTION[action], service];
    // `simctl privacy` requires the bundle id for grant/revoke (enforced by the
    // tool schema); for reset it is optional — omitting it resets the service
    // for every app on the device.
    if (bundleId) args.push(bundleId);

    try {
      await execFileAsync("xcrun", args, { timeout: 30_000 });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Distinguish "this Xcode's simctl doesn't model that service" (a
      // capability gap worth naming) from an ordinary simctl failure. The
      // pattern is a best-effort heuristic: the rejection text comes from a
      // CoreSimulator NSError whose exact wording we could not pin on an Xcode
      // that rejects a service (this host's accepts everything we map, camera
      // included). A miss just falls through to the generic branch with
      // simctl's own text — nothing is lost, only the nicer hint.
      const unsupportedService = /invalid.*service|unknown.*service/i.test(detail);
      // simctl privacy requires a booted device; its "Unable to lookup in
      // current state: Shutdown" doesn't tell an agent what to do about it.
      const shutdownHint = /current state:\s*shutdown/i.test(detail)
        ? " The simulator must be booted first — use boot-device."
        : "";
      throw new FailureError(
        unsupportedService
          ? `This Xcode's \`simctl privacy\` does not support the '${service}' service ` +
              `(simctl said: ${detail.trim()}). Run \`xcrun simctl privacy\` to list the services it supports.`
          : `Failed to ${action} '${permission}' on ${udid}: ${detail.trim()}${shutdownHint}`,
        {
          error_code: unsupportedService
            ? FAILURE_CODES.SETTINGS_PERMISSION_UNSUPPORTED
            : FAILURE_CODES.IOS_SETTINGS_PERMISSION_FAILED,
          failure_stage: "ios_settings_permission_simctl_privacy",
          failure_area: "tool_server",
          error_kind: unsupportedService ? "unsupported" : "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }

    return {
      action,
      permission,
      ...(bundleId ? { bundleId } : {}),
      applied: [service],
    };
  },
};
