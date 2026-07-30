import {
  FLAG_REGISTRY,
  isFeatureEnabled,
  setFlag,
  type FlagDefinition,
  type FlagsPathOptions,
} from "./flags.js";

export const REMOTE_PREFERENCES_VERSION = 1 as const;

/**
 * Portable preferences sent from an Argent client to a linked tool-server.
 * Telemetry is intentionally opt-out-only: linking may extend a user's local
 * privacy choice to the remote process, but must never override a remote
 * operator's existing opt-out by enabling telemetry.
 */
export interface RemotePreferencesSnapshot {
  version: typeof REMOTE_PREFERENCES_VERSION;
  flags: Record<string, boolean>;
  telemetry?: { enabled: false };
}

export interface AppliedRemotePreferences {
  appliedFlags: string[];
  ignoredFlags: string[];
}

export class RemotePreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemotePreferencesValidationError";
  }
}

/** Build the allowlisted, effective flag values that a linked server may use. */
export function buildRemotePreferencesSnapshot(
  options: FlagsPathOptions & { telemetryEnabled?: boolean } = {},
  registry: readonly FlagDefinition[] = FLAG_REGISTRY
): RemotePreferencesSnapshot {
  const flags: Record<string, boolean> = {};
  for (const definition of registry) {
    if (definition.remoteSync !== "live") continue;
    flags[definition.name] = isFeatureEnabled(definition.name, options, registry);
  }

  return {
    version: REMOTE_PREFERENCES_VERSION,
    flags,
    ...(options.telemetryEnabled === false ? { telemetry: { enabled: false as const } } : {}),
  };
}

/** Parse the untrusted HTTP payload without accepting arbitrary config data. */
export function parseRemotePreferencesSnapshot(raw: unknown): RemotePreferencesSnapshot {
  if (!isRecord(raw)) {
    throw new RemotePreferencesValidationError("Preference snapshot must be a JSON object.");
  }
  if (raw.version !== REMOTE_PREFERENCES_VERSION) {
    throw new RemotePreferencesValidationError(
      `Unsupported preference snapshot version; expected ${REMOTE_PREFERENCES_VERSION}.`
    );
  }
  if (!isRecord(raw.flags)) {
    throw new RemotePreferencesValidationError(
      'Preference snapshot field "flags" must be an object.'
    );
  }

  const flagEntries = Object.entries(raw.flags);
  if (flagEntries.length > 100) {
    throw new RemotePreferencesValidationError("Preference snapshot contains too many flags.");
  }
  const flags: Record<string, boolean> = {};
  for (const [name, value] of flagEntries) {
    if (typeof value !== "boolean") {
      throw new RemotePreferencesValidationError(`Flag "${name}" must be boolean.`);
    }
    flags[name] = value;
  }

  let telemetry: RemotePreferencesSnapshot["telemetry"];
  if (raw.telemetry !== undefined) {
    if (!isRecord(raw.telemetry) || raw.telemetry.enabled !== false) {
      throw new RemotePreferencesValidationError(
        'Preference snapshot field "telemetry.enabled" may only be false.'
      );
    }
    telemetry = { enabled: false };
  }

  return {
    version: REMOTE_PREFERENCES_VERSION,
    flags,
    ...(telemetry ? { telemetry } : {}),
  };
}

/** Apply only flags the receiving server explicitly marks as remotely syncable. */
export function applyRemotePreferenceFlags(
  snapshot: RemotePreferencesSnapshot,
  options: FlagsPathOptions = {},
  registry: readonly FlagDefinition[] = FLAG_REGISTRY
): AppliedRemotePreferences {
  const remotelySyncable = new Set(
    registry.filter((definition) => definition.remoteSync === "live").map(({ name }) => name)
  );
  const appliedFlags: string[] = [];
  const ignoredFlags: string[] = [];

  for (const [name, value] of Object.entries(snapshot.flags)) {
    if (!remotelySyncable.has(name)) {
      ignoredFlags.push(name);
      continue;
    }
    setFlag(name, value, "global", options);
    appliedFlags.push(name);
  }

  return { appliedFlags, ignoredFlags };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
