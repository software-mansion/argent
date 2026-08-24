import {
  FLAG_REGISTRY,
  isFeatureEnabled,
  replaceRuntimeFlagOverrides,
  type FlagDefinition,
  type FlagsPathOptions,
} from "./flags.js";

export const REMOTE_PREFERENCES_VERSION = 1 as const;

/** The small, explicit preference set understood by a linked tool-server. */
export interface RemotePreferencesSnapshot {
  version: typeof REMOTE_PREFERENCES_VERSION;
  flags: Record<string, boolean>;
  /** Disable-only: false never enables telemetry on the receiving server. */
  telemetryDisabled: boolean;
}

export class RemotePreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemotePreferencesValidationError";
  }
}

/** Build effective values for only flags explicitly marked as live + portable. */
export function buildRemotePreferencesSnapshot(
  options: FlagsPathOptions & { telemetryEnabled?: boolean } = {},
  registry: readonly FlagDefinition[] = FLAG_REGISTRY
): RemotePreferencesSnapshot {
  const flags: Record<string, boolean> = {};
  for (const definition of registry) {
    if (!definition.syncToRemote) continue;
    flags[definition.name] = isFeatureEnabled(definition.name, options, registry);
  }
  return {
    version: REMOTE_PREFERENCES_VERSION,
    flags,
    telemetryDisabled: options.telemetryEnabled === false,
  };
}

/** Validate the complete untrusted HTTP payload before anything is applied. */
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
  if (typeof raw.telemetryDisabled !== "boolean") {
    throw new RemotePreferencesValidationError(
      'Preference snapshot field "telemetryDisabled" must be boolean.'
    );
  }

  const entries = Object.entries(raw.flags);
  if (entries.length > 100) {
    throw new RemotePreferencesValidationError("Preference snapshot contains too many flags.");
  }
  for (const [name, value] of entries) {
    if (typeof value !== "boolean") {
      throw new RemotePreferencesValidationError(`Flag "${name}" must be boolean.`);
    }
  }

  return {
    version: REMOTE_PREFERENCES_VERSION,
    flags: Object.fromEntries(entries) as Record<string, boolean>,
    telemetryDisabled: raw.telemetryDisabled,
  };
}

/** Replace the runtime overlay with only flags the receiver allowlists. */
export function applyRemotePreferenceFlags(
  snapshot: RemotePreferencesSnapshot,
  registry: readonly FlagDefinition[] = FLAG_REGISTRY
): void {
  const syncable = new Set(
    registry.filter(({ syncToRemote }) => syncToRemote).map(({ name }) => name)
  );
  const overrides: Record<string, boolean> = {};

  for (const [name, value] of Object.entries(snapshot.flags)) {
    if (!syncable.has(name)) continue;
    overrides[name] = value;
  }

  replaceRuntimeFlagOverrides(overrides);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
