import type { RequestHandler } from "express";
import {
  RemotePreferencesValidationError,
  applyRemotePreferenceFlags,
  parseRemotePreferencesSnapshot,
} from "@argent/configuration-core";
import { disableForSession } from "@argent/telemetry";

export interface RemotePreferencesSyncRouteOptions {
  onActivity?: () => void;
  disableTelemetry?: () => Promise<boolean>;
}

/** Authenticated administrative route used by `argent link`, never exposed as a tool. */
export function makeRemotePreferencesSyncRoute(
  options: RemotePreferencesSyncRouteOptions = {}
): RequestHandler {
  return async (req, res) => {
    options.onActivity?.();
    try {
      const snapshot = parseRemotePreferencesSnapshot(req.body);
      let telemetryDisabled = false;
      if (snapshot.telemetryDisabled) {
        telemetryDisabled = await (options.disableTelemetry ?? disableForSession)();
        if (!telemetryDisabled) {
          throw new Error("Telemetry session opt-out did not take effect.");
        }
      }

      applyRemotePreferenceFlags(snapshot);
      res.json({
        version: snapshot.version,
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
