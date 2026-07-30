import type { RequestHandler } from "express";
import {
  RemotePreferencesValidationError,
  applyRemotePreferenceFlags,
  parseRemotePreferencesSnapshot,
} from "@argent/configuration-core";
import { markDisabled as disableTelemetry } from "@argent/telemetry";

/**
 * Authenticated administrative route used by `argent link`. It is deliberately
 * separate from the MCP tool registry so an agent cannot mutate server policy.
 */
export function makeRemotePreferencesSyncRoute(onActivity?: () => void): RequestHandler {
  return async (req, res) => {
    onActivity?.();
    try {
      const snapshot = parseRemotePreferencesSnapshot(req.body);
      const { appliedFlags, ignoredFlags } = applyRemotePreferenceFlags(snapshot);
      const telemetryDisabled = snapshot.telemetry?.enabled === false;
      if (telemetryDisabled) {
        await disableTelemetry();
      }
      res.json({
        version: snapshot.version,
        appliedFlags,
        ignoredFlags,
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
