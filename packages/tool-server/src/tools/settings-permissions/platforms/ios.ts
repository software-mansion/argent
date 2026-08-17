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

// Tool action → `simctl privacy` action. Only the deny/revoke name differs;
// the tool says "deny" because that's the vocabulary of the permission dialog
// the agent is replacing.
const SIMCTL_ACTION: Record<PermissionAction, "grant" | "revoke" | "reset"> = {
  grant: "grant",
  deny: "revoke",
  reset: "reset",
};

// Tool permission → the `simctl privacy` service(s) it covers. A LIST because a
// single tool permission can span more than one TCC service, and the first
// entry is the primary one (its failure fails the action); later entries are
// best-effort refinements.
// - `photos` covers both full-library access (`photos`, kTCCServicePhotos) and
//   add-only access (`photos-add`, kTCCServicePhotosAdd), which simctl lists as
//   separate services. A deny/reset that touched only `photos` would leave a
//   surviving add-only grant, so photos fans out to both; `photos-add` is
//   best-effort since some runtimes may not model it.
// - `notifications` is empty: notification authorization lives outside TCC, so
//   it surfaces a clear unsupported error instead of a bogus simctl call.
// - `camera` support varies by simruntime (simulators have no camera hardware,
//   and some runtimes don't model the service — independent of whether `simctl
//   privacy`'s usage text lists it). It is passed through rather than
//   pre-rejected so a runtime that accepts it works; a runtime that rejects it
//   fails with a generic NSError (NSPOSIXErrorDomain, "Failed to set access" /
//   "Operation not permitted") that carries no reliable "unsupported service"
//   text, so the handler below keys a list-services hint off the service name
//   rather than the message wording.
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

// Permissions whose authorization does NOT live in TCC.db. `location` /
// `location-always` are tracked by locationd's clients.plist, keyed on an
// *installed* app: `simctl privacy grant location <bundleId>` against a
// not-yet-installed app exits 0 but records nothing, and — unlike a TCC service
// — the grant is not persisted to be applied on a later install. So a grant of
// one of these must verify the app is installed first, or the tool would report
// a success that never happened. TCC-backed services are exempt: a pre-install
// grant there is legitimately stored and applied once the app installs.
const NON_TCC_GRANT_NEEDS_INSTALL: ReadonlySet<PermissionName> = new Set([
  "location",
  "location-always",
]);

// Runs one `simctl privacy` mutation (throwing on failure) plus an optional
// install probe. Lets a single handler serve local sims (`xcrun simctl`) and
// remote sims (`sim-remote simctl`) without an `isRemote` branch in the body.
// Only the local backend can probe install state (`simctl get_app_container`);
// sim-remote has no app-container verb, so the remote backend omits it and the
// location pre-grant guard is skipped there.
interface IosPrivacyBackend {
  run(udid: string, simctlAction: string, service: string, bundleId: string): Promise<void>;
  /**
   * Whether `bundleId` is installed on `udid`, when the backend can tell:
   * `true` installed, `false` definitively not installed, `undefined` when the
   * probe couldn't answer (e.g. a shutdown/booting simulator, where the probe
   * fails for installed and missing apps alike). Omitted entirely by backends
   * that can't probe (sim-remote). The location grant guard only rejects on a
   * definitive `false`, so an `undefined` verdict falls through to the privacy
   * call, which then surfaces the real cause (e.g. the boot-device hint).
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
      // Exits 0 and prints the container path for an installed app.
      await execFileAsync(
        "xcrun",
        await simctlArgsForUdid(udid, ["get_app_container", udid, bundleId]),
        { timeout: 15_000 }
      );
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // A definitive "not installed" verdict only for the shapes
      // `get_app_container` actually emits for a missing app ("No such file or
      // directory" / "... is not installed"). Every other failure is the probe
      // failing to answer, not the app being absent — a shutdown/booting sim
      // ("Unable to lookup in current state: Shutdown", which fails for
      // installed AND missing apps alike), a stale/deleted UDID ("Invalid
      // device"), a killed probe at its timeout — so return undefined: the
      // guard is skipped and the privacy call surfaces the real cause (e.g.
      // the boot hint) instead of misdirecting the agent to install the app.
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

    // Location auth isn't stored in TCC and doesn't persist for a not-yet-
    // installed app, so a pre-install grant silently records nothing. Reject it
    // up front with an actionable error instead of returning a false success.
    if (action === "grant" && NON_TCC_GRANT_NEEDS_INSTALL.has(permission) && backend.isInstalled) {
      const installed = await backend.isInstalled(udid, bundleId);
      // Only reject on a definitive "not installed"; an undefined verdict (probe
      // couldn't answer, e.g. shutdown sim) falls through so the privacy call
      // reports the real cause rather than a wrong "install the app" steer.
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
        // A secondary service (e.g. `photos-add`) that this runtime doesn't
        // model must not fail the whole action — the primary already succeeded
        // or will report its own failure. Skip it silently.
        if (!isPrimary) continue;
        const detail = err instanceof Error ? err.message : String(err);
        // simctl privacy requires a booted device; its "Unable to lookup in
        // current state: Shutdown" doesn't tell an agent what to do about it.
        const shutdownHint = /current state:\s*shutdown/i.test(detail)
          ? " The simulator must be booted first — use boot-device."
          : "";
        // `camera` is the one service some simruntimes don't model (simulators
        // have no camera hardware). simctl rejects an unsupported service with a
        // generic NSError (NSPOSIXErrorDomain, "Failed to set access" /
        // "Operation not permitted") that is indistinguishable from any other
        // failure, so there is no reliable text to classify it as unsupported —
        // key the hint off the service we know can be missing instead of
        // parsing simctl's wording.
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
            // Both backends run the `simctl privacy` verb (local via xcrun,
            // remote via sim-remote), so it's the same subprocess for telemetry.
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

// Remote analogue of `iosImpl`: routes `simctl privacy` through `sim-remote`
// instead of `xcrun`. The install probe is unavailable remotely, so the
// location pre-grant guard is skipped (the backend omits `isInstalled`).
export const iosRemoteImpl: PlatformImpl<
  SettingsPermissionsServices,
  SettingsPermissionsParams,
  SettingsPermissionsResult
> = {
  requires: ["sim-remote"],
  handler: buildIosHandler(remoteBackend),
};
