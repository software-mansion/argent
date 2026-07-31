import {
  buildRemotePreferencesSnapshot,
  type RemotePreferencesSnapshot,
} from "@argent/configuration-core";
import { getConsentState } from "@argent/telemetry";

const SYNC_TIMEOUT_MS = 3_000;

export type RemotePreferencesSyncResult =
  | {
      status: "synced";
      appliedFlags: string[];
      ignoredFlags: string[];
      appliedConfig: string[];
      ignoredConfig: string[];
      telemetryDisabled: boolean;
    }
  | { status: "unsupported" }
  | { status: "failed"; error: string };

export async function syncLinkedServerPreferences(
  url: string,
  token?: string,
  fetchImpl: typeof fetch = fetch
): Promise<RemotePreferencesSyncResult> {
  const snapshot = buildRemotePreferencesSnapshot({
    effectiveConfig: { "telemetry.enabled": getConsentState().enabled },
  });
  return pushRemotePreferences(url, token, snapshot, fetchImpl);
}

/** Exported separately so the HTTP compatibility behavior stays unit-testable. */
export async function pushRemotePreferences(
  url: string,
  token: string | undefined,
  snapshot: RemotePreferencesSnapshot,
  fetchImpl: typeof fetch = fetch
): Promise<RemotePreferencesSyncResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, "")}/preferences/sync`, {
      method: "PUT",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(snapshot),
    });

    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return { status: "unsupported" };
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 1_000);
      return {
        status: "failed",
        error: `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      };
    }

    const body: unknown = await response.json();
    if (!isRecord(body) || body.version !== snapshot.version) {
      return { status: "failed", error: "Invalid preference sync response version." };
    }
    const appliedFlags = parseStringArray(body.appliedFlags);
    const ignoredFlags = parseStringArray(body.ignoredFlags);
    const appliedConfig = parseStringArray(body.appliedConfig);
    const ignoredConfig = parseStringArray(body.ignoredConfig);
    if (
      !appliedFlags ||
      !ignoredFlags ||
      !appliedConfig ||
      !ignoredConfig ||
      typeof body.telemetryDisabled !== "boolean"
    ) {
      return { status: "failed", error: "Invalid preference sync response body." };
    }
    if (snapshot.config["telemetry.enabled"] === false && !body.telemetryDisabled) {
      return { status: "failed", error: "Remote telemetry opt-out was not confirmed." };
    }
    return {
      status: "synced",
      appliedFlags,
      ignoredFlags,
      appliedConfig,
      ignoredConfig,
      telemetryDisabled: body.telemetryDisabled,
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function parseStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
