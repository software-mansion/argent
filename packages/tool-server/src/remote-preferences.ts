import type { RequestHandler } from "express";
import {
  RemotePreferencesValidationError,
  activateRemotePreferences,
  clearRemotePreferences,
  parseRemotePreferencesSnapshot,
  resolveRemotePreferences,
} from "@argent/configuration-core";
import { clearSessionTelemetryOptOut, disableForSession } from "@argent/telemetry";

let remotePreferencesActive = false;

export interface RemotePreferencesSyncRouteOptions {
  onActivity?: () => void;
  disableTelemetry?: () => Promise<boolean>;
}

/**
 * Authenticated administrative route used by `argent link`. It is deliberately
 * separate from the MCP tool registry so an agent cannot mutate server policy.
 */
export function makeRemotePreferencesSyncRoute(
  options: RemotePreferencesSyncRouteOptions = {}
): RequestHandler {
  return async (req, res) => {
    options.onActivity?.();
    try {
      const snapshot = parseRemotePreferencesSnapshot(req.body);
      const resolved = resolveRemotePreferences(snapshot);
      const telemetryRequested = resolved.configOverrides["telemetry.enabled"] === false;
      let telemetryDisabled = false;
      if (telemetryRequested) {
        telemetryDisabled = await (options.disableTelemetry ?? disableForSession)();
        if (!telemetryDisabled) {
          throw new Error("Telemetry session opt-out did not take effect.");
        }
      }

      // Activate only after all validation and the privacy-sensitive side
      // effect have succeeded, so a failed request cannot leave partial flags.
      activateRemotePreferences(resolved);
      remotePreferencesActive = true;
      res.json({
        version: snapshot.version,
        appliedFlags: resolved.appliedFlags,
        ignoredFlags: resolved.ignoredFlags,
        appliedConfig: resolved.appliedConfig,
        ignoredConfig: resolved.ignoredConfig,
        telemetryDisabled,
      });
    } catch (error) {
      if (error instanceof RemotePreferencesValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(500).json({
        error: `Failed to apply remote preferences: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
}

/** Release every process-scoped preference installed through the sync route. */
export function clearRemotePreferencesForSession(): void {
  if (!remotePreferencesActive) return;
  clearRemotePreferences();
  clearSessionTelemetryOptOut();
  remotePreferencesActive = false;
}
