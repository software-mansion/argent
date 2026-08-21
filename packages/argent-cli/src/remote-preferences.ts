import {
  buildRemotePreferencesSnapshot,
  type RemotePreferencesSnapshot,
} from "@argent/configuration-core";
import { getConsentState } from "@argent/telemetry";

const SYNC_TIMEOUT_MS = 3_000;

export type RemotePreferencesSyncResult =
  | {
      status: "synced";
      telemetryDisabled: boolean;
    }
  | { status: "unsupported" }
  | { status: "failed"; error: string };

export async function syncLinkedServerPreferences(
  url: string,
  token?: string
): Promise<RemotePreferencesSyncResult> {
  const snapshot = buildRemotePreferencesSnapshot({
    telemetryEnabled: getConsentState().enabled,
  });
  return pushRemotePreferences(url, token, snapshot);
}

/** Exported separately so the HTTP compatibility behavior stays unit-testable. */
export async function pushRemotePreferences(
  url: string,
  token: string | undefined,
  snapshot: RemotePreferencesSnapshot
): Promise<RemotePreferencesSyncResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/preferences/sync`, {
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
    if (typeof body.telemetryDisabled !== "boolean") {
      return { status: "failed", error: "Invalid preference sync response body." };
    }
    if (snapshot.telemetryDisabled && !body.telemetryDisabled) {
      return { status: "failed", error: "Remote telemetry opt-out was not confirmed." };
    }
    return {
      status: "synced",
      telemetryDisabled: body.telemetryDisabled,
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
