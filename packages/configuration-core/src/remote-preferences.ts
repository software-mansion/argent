import {
  FLAG_REGISTRY,
  clearRuntimeFlagOverrides,
  isFeatureEnabled,
  replaceRuntimeFlagOverrides,
  type FlagDefinition,
} from "./flags.js";
import {
  clearRuntimeConfigOverrides,
  getConfigValue,
  replaceRuntimeConfigOverrides,
} from "./config-access.js";
import { CONFIG_SCHEMA, type ConfigDefinition } from "./config-schema.js";
import type { ConfigPathOptions } from "./paths.js";

export const REMOTE_PREFERENCES_VERSION = 1 as const;

/** Portable, allowlisted preferences sent to a linked tool-server. */
export interface RemotePreferencesSnapshot {
  version: typeof REMOTE_PREFERENCES_VERSION;
  flags: Record<string, boolean>;
  config: Record<string, unknown>;
}

export interface ResolvedRemotePreferences {
  flagOverrides: Record<string, boolean>;
  configOverrides: Record<string, unknown>;
  appliedFlags: string[];
  ignoredFlags: string[];
  appliedConfig: string[];
  ignoredConfig: string[];
}

export interface RemotePreferencesBuildOptions extends ConfigPathOptions {
  /** Effective values that live outside config storage, such as env consent. */
  effectiveConfig?: Readonly<Record<string, unknown>>;
}

export class RemotePreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemotePreferencesValidationError";
  }
}

/** Build effective values from only schema entries explicitly marked portable. */
export function buildRemotePreferencesSnapshot(
  options: RemotePreferencesBuildOptions = {},
  flagRegistry: readonly FlagDefinition[] = FLAG_REGISTRY,
  configRegistry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): RemotePreferencesSnapshot {
  const flags: Record<string, boolean> = {};
  for (const definition of flagRegistry) {
    if (definition.remoteSync !== "live") continue;
    flags[definition.name] = isFeatureEnabled(definition.name, options, flagRegistry);
  }

  const config: Record<string, unknown> = {};
  for (const definition of configRegistry) {
    if (!definition.remoteSync) continue;
    const raw = Object.hasOwn(options.effectiveConfig ?? {}, definition.key)
      ? options.effectiveConfig![definition.key]
      : getConfigValue(definition, options);
    const value = definition.parse(raw);
    if (value === undefined) continue;
    if (definition.remoteSync === "opt-out-only" && value !== false) continue;
    config[definition.key] = value;
  }

  return { version: REMOTE_PREFERENCES_VERSION, flags, config };
}

/** Parse the untrusted envelope; allowlist and per-key validation happen next. */
export function parseRemotePreferencesSnapshot(raw: unknown): RemotePreferencesSnapshot {
  if (!isRecord(raw)) {
    throw new RemotePreferencesValidationError("Preference snapshot must be a JSON object.");
  }
  if (raw.version !== REMOTE_PREFERENCES_VERSION) {
    throw new RemotePreferencesValidationError(
      `Unsupported preference snapshot version; expected ${REMOTE_PREFERENCES_VERSION}.`
    );
  }

  const flags = parseBooleanMap(raw.flags, "flags");
  if (!isRecord(raw.config)) {
    throw new RemotePreferencesValidationError(
      'Preference snapshot field "config" must be an object.'
    );
  }
  const configEntries = Object.entries(raw.config);
  if (configEntries.length > 100) {
    throw new RemotePreferencesValidationError(
      "Preference snapshot contains too many config values."
    );
  }

  return {
    version: REMOTE_PREFERENCES_VERSION,
    flags,
    config: Object.fromEntries(configEntries),
  };
}

/**
 * Validate and filter a parsed snapshot against the receiver's registries.
 * Nothing is activated until every recognized value has passed validation.
 */
export function resolveRemotePreferences(
  snapshot: RemotePreferencesSnapshot,
  flagRegistry: readonly FlagDefinition[] = FLAG_REGISTRY,
  configRegistry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): ResolvedRemotePreferences {
  const syncableFlags = new Set(
    flagRegistry.filter(({ remoteSync }) => remoteSync === "live").map(({ name }) => name)
  );
  const flagOverrides: Record<string, boolean> = {};
  const appliedFlags: string[] = [];
  const ignoredFlags: string[] = [];
  for (const [name, value] of Object.entries(snapshot.flags)) {
    if (!syncableFlags.has(name)) {
      ignoredFlags.push(name);
      continue;
    }
    flagOverrides[name] = value;
    appliedFlags.push(name);
  }

  const configByKey = new Map(configRegistry.map((definition) => [definition.key, definition]));
  const configOverrides: Record<string, unknown> = {};
  const appliedConfig: string[] = [];
  const ignoredConfig: string[] = [];
  for (const [key, raw] of Object.entries(snapshot.config)) {
    const definition = configByKey.get(key);
    if (!definition?.remoteSync) {
      ignoredConfig.push(key);
      continue;
    }
    const value = definition.parse(raw);
    if (value === undefined) {
      throw new RemotePreferencesValidationError(`Invalid value for config key "${key}".`);
    }
    if (definition.remoteSync === "opt-out-only" && value !== false) {
      throw new RemotePreferencesValidationError(`Config key "${key}" may only be false.`);
    }
    configOverrides[key] = value;
    appliedConfig.push(key);
  }

  return {
    flagOverrides,
    configOverrides,
    appliedFlags,
    ignoredFlags,
    appliedConfig,
    ignoredConfig,
  };
}

/** Activate a fully validated snapshot as a process-scoped replacement overlay. */
export function activateRemotePreferences(resolved: ResolvedRemotePreferences): void {
  replaceRuntimeFlagOverrides(resolved.flagOverrides);
  replaceRuntimeConfigOverrides(resolved.configOverrides);
}

/** Clear the complete process-scoped overlay. Primarily useful for test hosts. */
export function clearRemotePreferences(): void {
  clearRuntimeFlagOverrides();
  clearRuntimeConfigOverrides();
}

function parseBooleanMap(raw: unknown, field: string): Record<string, boolean> {
  if (!isRecord(raw)) {
    throw new RemotePreferencesValidationError(
      `Preference snapshot field "${field}" must be an object.`
    );
  }
  const entries = Object.entries(raw);
  if (entries.length > 100) {
    throw new RemotePreferencesValidationError("Preference snapshot contains too many flags.");
  }
  for (const [name, value] of entries) {
    if (typeof value !== "boolean") {
      throw new RemotePreferencesValidationError(`Flag "${name}" must be boolean.`);
    }
  }
  return Object.fromEntries(entries) as Record<string, boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
