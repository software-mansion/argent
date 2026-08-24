import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import { simctlPrivacy as remoteSimctlPrivacy } from "../../../utils/sim-remote";
import type {
  PermissionAction,
  PermissionName,
  SettingsPermissionsParams,
  SettingsPermissionsResult,
  SettingsPermissionsServices,
} from "../types";

const execFileAsync = promisify(execFile);

// The tool says "deny" — the permission dialog's vocabulary — where simctl
// says "revoke".
const SIMCTL_ACTION: Record<PermissionAction, "grant" | "revoke" | "reset"> = {
  grant: "grant",
  deny: "revoke",
  reset: "reset",
};

// Tool permission → `simctl privacy` service(s). A list because one permission
// can span several TCC services; the first is primary (its failure fails the
// action), later ones are best-effort.
// - `photos` fans out to add-only `photos-add` too, or a deny/reset would leave
//   a surviving add-only grant.
// - `notifications` is empty: it lives outside TCC, so the handler reports it as
//   unsupported instead of making a bogus simctl call.
// - `camera` is modeled only by some simruntimes, so it is passed through rather
//   than pre-rejected.
const IOS_SERVICES: Record<PermissionName, string[]> = {
  "camera": ["camera"],
  "microphone": ["microphone"],
  "photos": ["photos", "photos-add"],
  "contacts": ["contacts"],
  "notifications": [],
  "calendar": ["calendar"],
  "location": ["location"],
  "location-always": ["location-always"],
  "media-library": ["media-library"],
  "motion": ["motion"],
  "reminders": ["reminders"],
};

// Location auth lives in locationd's clients.plist, keyed on an *installed* app:
// a pre-install grant exits 0, records nothing and is never replayed on install,
// so it must verify installation first. TCC-backed grants are stored and applied
// once the app installs, so they are exempt.
const NON_TCC_GRANT_NEEDS_INSTALL: ReadonlySet<PermissionName> = new Set([
  "location",
  "location-always",
]);

// Lets one handler serve local (`xcrun simctl`) and remote (`sim-remote`) sims
// without an `isRemote` branch. Only local can probe install state
// (`get_app_container`); sim-remote has no such verb, so it omits the probe and
// the location pre-grant guard is skipped there.
interface IosPrivacyBackend {
  run(udid: string, simctlAction: string, service: string, bundleId: string): Promise<void>;
  /**
   * `false` only for a definitive "not installed"; `undefined` when the probe
   * couldn't answer (e.g. a shutdown simulator, where it fails for installed and
   * missing apps alike). The location guard rejects only on `false`.
   */
  isInstalled?(udid: string, bundleId: string): Promise<boolean | undefined>;
}

const localBackend: IosPrivacyBackend = {
  async run(udid, simctlAction, service, bundleId) {
    await execFileAsync(
      "xcrun",
      await simctlArgsForUdid(udid, ["privacy", udid, simctlAction, service, bundleId]),
      { timeout: 30_000 }
    );
  },
  async isInstalled(udid, bundleId) {
    try {
      // Exits 0 for an installed app.
      await execFileAsync(
        "xcrun",
        await simctlArgsForUdid(udid, ["get_app_container", udid, bundleId]),
        { timeout: 15_000 }
      );
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Only the shapes `get_app_container` emits for a missing app are a
      // verdict. Anything else (shutdown sim, stale UDID, timeout) is the probe
      // failing to answer, so the guard is skipped and the privacy call
      // surfaces the real cause instead of a wrong "install the app" steer.
      if (/no such file or directory|is not installed/i.test(detail)) return false;
      return undefined;
    }
  },
};

const remoteBackend: IosPrivacyBackend = {
  run: remoteSimctlPrivacy,
};

function buildIosHandler(
  backend: IosPrivacyBackend
): PlatformImpl<
  SettingsPermissionsServices,
  SettingsPermissionsParams,
  SettingsPermissionsResult
>["handler"] {
  return async (_services, params) => {
    const { udid, action, permission, bundleId } = params;

    const services = IOS_SERVICES[permission];
    if (services.length === 0) {
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

    // A pre-install location grant silently records nothing, so reject it up
    // front instead of reporting a success that never happened.
    if (action === "grant" && NON_TCC_GRANT_NEEDS_INSTALL.has(permission) && backend.isInstalled) {
      const installed = await backend.isInstalled(udid, bundleId);
      // An undefined verdict falls through so the privacy call reports the real
      // cause.
      if (installed === false) {
        throw new FailureError(
          `Cannot grant '${permission}' to ${bundleId} on ${udid}: the app is not installed. ` +
            `Location authorization isn't stored in TCC and isn't applied to a bundle id until the app ` +
            `exists on the device, so a pre-install grant would silently do nothing — install the app first, then grant.`,
          {
            error_code: FAILURE_CODES.IOS_SETTINGS_PERMISSION_FAILED,
            failure_stage: "ios_settings_permission_app_not_installed",
            failure_area: "tool_server",
            error_kind: "not_found",
          }
        );
      }
    }

    const applied: string[] = [];
    for (let i = 0; i < services.length; i++) {
      const service = services[i]!;
      const isPrimary = i === 0;
      try {
        await backend.run(udid, SIMCTL_ACTION[action], service, bundleId);
        applied.push(service);
      } catch (err) {
        // A secondary service (e.g. `photos-add`) this runtime doesn't model
        // must not fail the whole action.
        if (!isPrimary) continue;
        const detail = err instanceof Error ? err.message : String(err);
        // simctl's "Unable to lookup in current state: Shutdown" doesn't tell
        // an agent to boot the device.
        const shutdownHint = /current state:\s*shutdown/i.test(detail)
          ? " The simulator must be booted first — use boot-device."
          : "";
        // simctl rejects an unsupported service with a generic NSError that is
        // indistinguishable from any other failure, so the hint keys off the
        // one service that can be missing rather than simctl's wording.
        const cameraHint =
          service === "camera" && !shutdownHint
            ? " The 'camera' service isn't modeled by every simulator runtime (it varies by simruntime, not by the installed Xcode); try a different iOS runtime, or run `xcrun simctl privacy` to list the services it supports."
            : "";
        throw new FailureError(
          `Failed to ${action} '${permission}' on ${udid}: ${detail.trim()}${shutdownHint}${cameraHint}`,
          {
            error_code: FAILURE_CODES.IOS_SETTINGS_PERMISSION_FAILED,
            failure_stage: "ios_settings_permission_simctl_privacy",
            failure_area: "tool_server",
            error_kind: "subprocess",
            // Both backends run the same `simctl privacy` verb, so telemetry
            // uses one subprocess name.
            ...subprocessFailureMetadata(err, "xcrun_simctl"),
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
    }

    return {
      action,
      permission,
      bundleId,
      applied,
    };
  };
}

export const iosImpl: PlatformImpl<
  SettingsPermissionsServices,
  SettingsPermissionsParams,
  SettingsPermissionsResult
> = {
  requires: ["xcrun"],
  handler: buildIosHandler(localBackend),
};

// Routes `simctl privacy` through `sim-remote` instead of `xcrun`; no install
// probe remotely, so the location pre-grant guard is skipped.
export const iosRemoteImpl: PlatformImpl<
  SettingsPermissionsServices,
  SettingsPermissionsParams,
  SettingsPermissionsResult
> = {
  requires: ["sim-remote"],
  handler: buildIosHandler(remoteBackend),
};
