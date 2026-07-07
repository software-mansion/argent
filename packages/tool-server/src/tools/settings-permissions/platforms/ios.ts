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
// - `camera` support varies by simruntime (simulators have no camera hardware,
//   and some runtimes don't model the service — independent of whether `simctl
//   privacy`'s usage text lists it). It is passed through rather than
//   pre-rejected so a runtime that accepts it works; a runtime that rejects it
//   fails with a generic NSError (NSPOSIXErrorDomain, "Failed to set access" /
//   "Operation not permitted") that carries no reliable "unsupported service"
//   text, so the handler below keys a list-services hint off the service name
//   rather than the message wording.
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

    // Always per-app (bundleId is schema-required). A device-wide reset with no
    // bundleId is deliberately not offered: on recent iOS runtimes simctl exits
    // 0 but leaves every existing per-app TCC row intact, so it would report a
    // success that never happened. A per-app `reset <service> <bundleId>` does
    // remove the row.
    const args = ["simctl", "privacy", udid, SIMCTL_ACTION[action], service, bundleId];

    try {
      await execFileAsync("xcrun", args, { timeout: 30_000 });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // simctl privacy requires a booted device; its "Unable to lookup in
      // current state: Shutdown" doesn't tell an agent what to do about it.
      const shutdownHint = /current state:\s*shutdown/i.test(detail)
        ? " The simulator must be booted first — use boot-device."
        : "";
      // `camera` is the one service some simruntimes don't model (simulators
      // have no camera hardware). simctl rejects an unsupported service with a
      // generic NSError (NSPOSIXErrorDomain, "Failed to set access" / "Operation
      // not permitted") that is indistinguishable from any other failure, so
      // there is no reliable text to classify it as unsupported — key the hint
      // off the service we know can be missing instead of parsing simctl's
      // wording.
      const cameraHint =
        service === "camera" && !shutdownHint
          ? " If this Xcode's `simctl privacy` does not model the 'camera' service, run `xcrun simctl privacy` to list the services it supports."
          : "";
      throw new FailureError(
        `Failed to ${action} '${permission}' on ${udid}: ${detail.trim()}${shutdownHint}${cameraHint}`,
        {
          error_code: FAILURE_CODES.IOS_SETTINGS_PERMISSION_FAILED,
          failure_stage: "ios_settings_permission_simctl_privacy",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }

    return {
      action,
      permission,
      bundleId,
      applied: [service],
    };
  },
};
