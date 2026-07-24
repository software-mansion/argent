// Schema-driven read/write for scoped configuration values.
//
// This is the layer the rest of argent should use to read a configuration:
// instead of poking at a single global config.json, `getConfigValue` reads
// every scope the value's schema entry allows, merges them under the entry's
// policy, and falls back to the entry's default. `setConfigValue` /
// `unsetConfigValue` validate against the schema before writing. `argent config`
// and the migrated lens getters are both thin wrappers over these.

import type { FlagScope } from "./flags.js";
import type { ConfigPathOptions } from "./paths.js";
import { readConfigObject, updateConfig, getAtPath, setAtPath, deleteAtPath } from "./config.js";
import { applyMergePolicy } from "./merge.js";
import { CONFIG_SCHEMA, getConfigDefinition, type ConfigDefinition } from "./config-schema.js";

/** Read + parse one scope's value for a definition (no merge, no default). */
function readScopeValue<T>(
  def: ConfigDefinition<T>,
  scope: FlagScope,
  options: ConfigPathOptions
): T | undefined {
  if (!def.scopes.includes(scope)) return undefined;
  const raw = getAtPath(readConfigObject(scope, options), def.key);
  return raw === undefined ? undefined : def.parse(raw);
}

/**
 * The effective value of a configuration: the project and global scopes read,
 * validated, merged under the entry's policy, then defaulted. This is what a
 * runtime consumer (e.g. the simctl device-set reader) should call.
 */
export function getConfigValue<T>(
  def: ConfigDefinition<T>,
  options: ConfigPathOptions = {}
): T | undefined {
  const local = readScopeValue(def, "project", options);
  const global = readScopeValue(def, "global", options);
  const merged = applyMergePolicy(def.merge, local, global);
  return merged ?? def.default;
}

/** The raw parsed value stored at a single scope (no merge/default). Throws on
 * an unknown key. Backs `argent config get --scope`. */
export function getConfigValueAtScope(
  key: string,
  scope: FlagScope,
  options: ConfigPathOptions = {},
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): unknown {
  const def = requireDefinition(key, registry);
  return readScopeValue(def, scope, options);
}

/** Same as `getConfigValue` but looked up by key; throws on an unknown key. */
export function getConfigValueByKey(
  key: string,
  options: ConfigPathOptions = {},
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): unknown {
  const def = requireDefinition(key, registry);
  return getConfigValue(def, options);
}

function requireDefinition(
  key: string,
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): ConfigDefinition {
  const def = getConfigDefinition(key, registry);
  if (!def) {
    throw new UnknownConfigKeyError(key);
  }
  return def;
}

/** Thrown when a key is not present in the schema. */
export class UnknownConfigKeyError extends Error {
  constructor(public readonly key: string) {
    super(`Unknown configuration key "${key}".`);
    this.name = "UnknownConfigKeyError";
  }
}

/** Thrown when a write targets a scope the value's schema does not allow. */
export class ConfigScopeError extends Error {
  constructor(
    public readonly key: string,
    public readonly scope: FlagScope,
    public readonly allowed: readonly FlagScope[]
  ) {
    super(`Config key "${key}" cannot be set at ${scope} scope (allowed: ${allowed.join(", ")}).`);
    this.name = "ConfigScopeError";
  }
}

/** Thrown when a value fails the schema's `parse` validator. */
export class ConfigValidationError extends Error {
  constructor(public readonly key: string) {
    super(`Invalid value for config key "${key}".`);
    this.name = "ConfigValidationError";
  }
}

/**
 * Thrown when a key is delegated to a dedicated command (`manageCommand`) and
 * must not be written through the generic `argent config` path.
 */
export class ConfigManagedElsewhereError extends Error {
  constructor(
    public readonly key: string,
    public readonly command: string
  ) {
    super(`Config key "${key}" is managed by \`${command}\`.`);
    this.name = "ConfigManagedElsewhereError";
  }
}

/**
 * Validate and persist a configuration value at a scope. `rawValue` is a
 * pre-parsed JSON value (the CLI coerces its string argument first); it is run
 * through the schema's validator, and the normalized result is stored. Returns
 * the normalized value that was written, so callers can report exactly what
 * landed on disk rather than the raw input.
 */
export function setConfigValue(
  key: string,
  rawValue: unknown,
  scope: FlagScope = "global",
  options: ConfigPathOptions = {},
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): unknown {
  const def = requireDefinition(key, registry);
  if (def.manageCommand) throw new ConfigManagedElsewhereError(key, def.manageCommand);
  if (!def.scopes.includes(scope)) throw new ConfigScopeError(key, scope, def.scopes);
  const parsed = def.parse(rawValue);
  if (parsed === undefined) throw new ConfigValidationError(key);
  updateConfig((config) => setAtPath(config, key, parsed), scope, options);
  return parsed;
}

/**
 * Remove a configuration value at a scope. Returns true when an entry was
 * removed. Refuses keys delegated to a dedicated command.
 */
export function unsetConfigValue(
  key: string,
  scope: FlagScope = "global",
  options: ConfigPathOptions = {},
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): boolean {
  const def = requireDefinition(key, registry);
  if (def.manageCommand) throw new ConfigManagedElsewhereError(key, def.manageCommand);
  if (!def.scopes.includes(scope)) throw new ConfigScopeError(key, scope, def.scopes);
  // Fast path for a no-op: if the key is absent at this scope there is nothing
  // to remove, so skip the write path entirely. Otherwise `updateConfig` would
  // mkdir the scope's `.argent` dir and rewrite an unchanged config.json —
  // materializing a project file (and dirtying git status) for an unset that
  // removed nothing.
  if (getAtPath(readConfigObject(scope, options), key) === undefined) return false;
  let removed = false;
  updateConfig(
    (config) => {
      removed = deleteAtPath(config, key);
    },
    scope,
    options
  );
  return removed;
}

/** A schema entry plus its current per-scope and effective values, for display. */
export interface ConfigEntryView {
  key: string;
  description: string;
  scopes: readonly FlagScope[];
  manageCommand?: string;
  /** Effective (merged + defaulted) value. */
  effective: unknown;
  /** Raw parsed value stored at the project scope, or undefined. */
  project: unknown;
  /** Raw parsed value stored at the global scope, or undefined. */
  global: unknown;
}

/** Every schema entry with its current values — backs `argent config list`. */
export function listConfig(
  options: ConfigPathOptions = {},
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): ConfigEntryView[] {
  return registry.map((def) => ({
    key: def.key,
    description: def.description,
    scopes: def.scopes,
    ...(def.manageCommand ? { manageCommand: def.manageCommand } : {}),
    effective: getConfigValue(def, options),
    project: readScopeValue(def, "project", options),
    global: readScopeValue(def, "global", options),
  }));
}

/**
 * Coerce a raw CLI string into a JSON value for `setConfigValue`. Tries JSON
 * first (so `true`, `42`, `["a","b"]` parse to their types) and falls back to
 * the literal string (so bare paths like `/tmp/set` don't need quoting).
 */
export function coerceCliValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ── Argent Lens preferences (migrated onto the schema) ────────────────────
// `lens.agent` is a real schema entry now, so these wrappers demonstrate the
// merged reader on a live consumer: a project can pin the agent, falling back
// to the user's global remembered choice. The public surface is unchanged so
// `argent lens` keeps working without edits.

const LENS_AGENT_KEY = "lens.agent";

/** The remembered `argent lens` agent id, or null when none is stored. */
export function getRememberedAgent(options: ConfigPathOptions = {}): string | null {
  const value = getConfigValueByKey(LENS_AGENT_KEY, options);
  return typeof value === "string" && value.trim() ? value : null;
}

/** Persist the chosen `argent lens` agent id so later runs skip the picker. */
export function setRememberedAgent(agentId: string, options: ConfigPathOptions = {}): void {
  setConfigValue(LENS_AGENT_KEY, agentId, "global", options);
}

/** Forget the remembered `argent lens` agent (so the picker shows again). */
export function clearRememberedAgent(options: ConfigPathOptions = {}): void {
  unsetConfigValue(LENS_AGENT_KEY, "global", options);
}
