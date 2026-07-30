import {
  buildRemotePreferencesSnapshot,
  type RemotePreferencesSnapshot,
} from "@argent/configuration-core";
import { getConsentState } from "@argent/telemetry";

const SYNC_TIMEOUT_MS = 3_000;

export type RemotePreferencesSyncResult =
  | { status: "synced"; appliedFlags: string[]; ignoredFlags: string[]; telemetryDisabled: boolean }
  | { status: "unsupported" }
  | { status: "failed"; error: string };

export async function syncLinkedServerPreferences(
  url: string,
  token?: string,
  fetchImpl: typeof fetch = fetch
): Promise<RemotePreferencesSyncResult> {
  const snapshot = buildRemotePreferencesSnapshot({
    telemetryEnabled: getConsentState().enabled,
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
    const response = await fetchImpl(`${url.replace(/\/$/, "")}/preferences/sync`, {
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
      const detail = await response.text().catch(() => "");
      return {
        status: "failed",
        error: `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      };
    }

    const body = (await response.json()) as {
      appliedFlags?: unknown;
      ignoredFlags?: unknown;
      telemetryDisabled?: unknown;
    };
    return {
      status: "synced",
      appliedFlags: stringArray(body.appliedFlags),
      ignoredFlags: stringArray(body.ignoredFlags),
      telemetryDisabled: body.telemetryDisabled === true,
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
