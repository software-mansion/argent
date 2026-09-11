import * as path from "node:path";
import { resolveProjectRoot, type FlagScope } from "./flags.js";
import { resolveHomeDir, type ConfigPathOptions } from "./paths.js";
import { readConfigObject, updateConfig, getAtPath, setAtPath, deleteAtPath } from "./config.js";
import { applyMergePolicy } from "./merge.js";
import {
  CONFIG_SCHEMA,
  describeExpectedValue,
  getConfigDefinition,
  type ConfigDefinition,
} from "./config-schema.js";

function readScopeValue<T>(
  def: ConfigDefinition<T>,
  scope: FlagScope,
  options: ConfigPathOptions
): T | undefined {
  if (!def.scopes.includes(scope)) return undefined;
  const raw = getAtPath(readConfigObject(scope, options), def.key);
  return raw === undefined ? undefined : def.parse(raw);
}

export function getConfigValue<T>(
  def: ConfigDefinition<T>,
  options: ConfigPathOptions = {}
): T | undefined {
  const local = readScopeValue(def, "project", options);
  const global = readScopeValue(def, "global", options);
  const merged = applyMergePolicy(def.merge, local, global);
  return merged ?? def.default;
}

export function getConfigValueAtScope(
  key: string,
  scope: FlagScope,
  options: ConfigPathOptions = {},
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): unknown {
  const def = requireDefinition(key, registry);
  return readScopeValue(def, scope, options);
}

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

export class UnknownConfigKeyError extends Error {
  constructor(public readonly key: string) {
    super(`Unknown configuration key "${key}".`);
    this.name = "UnknownConfigKeyError";
  }
}

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

export class ConfigValidationError extends Error {
  constructor(
    public readonly key: string,
    public readonly expected?: string,
    public readonly example?: string
  ) {
    super(
      expected
        ? `Invalid value for config key "${key}": expected ${expected}.`
        : `Invalid value for config key "${key}".`
    );
    this.name = "ConfigValidationError";
  }
}

export class ConfigManagedElsewhereError extends Error {
  constructor(
    public readonly key: string,
    public readonly command: string
  ) {
    super(`Config key "${key}" is managed by \`${command}\`.`);
    this.name = "ConfigManagedElsewhereError";
  }
}

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
  const parsed = (def.validateWrite ?? def.parse)(rawValue);
  if (parsed === undefined)
    throw new ConfigValidationError(def.key, describeExpectedValue(def), def.example);
  updateConfig((config) => setAtPath(config, key, parsed), scope, options);
  return parsed;
}

export function unsetConfigValue(
  key: string,
  scope: FlagScope = "global",
  options: ConfigPathOptions = {},
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): boolean {
  const def = requireDefinition(key, registry);
  if (def.manageCommand) throw new ConfigManagedElsewhereError(key, def.manageCommand);
  if (!def.scopes.includes(scope)) throw new ConfigScopeError(key, scope, def.scopes);
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

export interface ConfigEntryView {
  key: string;
  description: string;
  scopes: readonly FlagScope[];
  manageCommand?: string;
  expected?: string;
  example?: string;
  effective: unknown;
  project: unknown;
  global: unknown;
}

export function listConfig(
  options: ConfigPathOptions = {},
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): ConfigEntryView[] {
  return registry.map((def) => ({
    key: def.key,
    description: def.description,
    scopes: def.scopes,
    ...(def.manageCommand ? { manageCommand: def.manageCommand } : {}),
    ...(describeExpectedValue(def) ? { expected: describeExpectedValue(def)! } : {}),
    ...(def.example ? { example: def.example } : {}),
    effective: getConfigValue(def, options),
    project: readScopeValue(def, "project", options),
    global: readScopeValue(def, "global", options),
  }));
}

export function coerceCliValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const LENS_AGENT_KEY = "lens.agent";

export function getRememberedAgent(options: ConfigPathOptions = {}): string | null {
  const value = getConfigValueByKey(LENS_AGENT_KEY, options);
  return typeof value === "string" && value.trim() ? value : null;
}

export function setRememberedAgent(agentId: string, options: ConfigPathOptions = {}): void {
  setConfigValue(LENS_AGENT_KEY, agentId, "global", options);
}

export function clearRememberedAgent(options: ConfigPathOptions = {}): void {
  unsetConfigValue(LENS_AGENT_KEY, "global", options);
}

const IOS_ADDITIONAL_DEVICE_SETS_KEY = "ios.additionalDeviceSets";

export function getAdditionalIosDeviceSets(options: ConfigPathOptions = {}): string[] {
  const def = requireDefinition(IOS_ADDITIONAL_DEVICE_SETS_KEY) as ConfigDefinition<string[]>;
  // Path resolution must happen per scope *before* deduplication, so the union
  // is re-implemented here instead of going through `applyMergePolicy` — keep
  // the order in sync with the schema entry's `union` preset.
  if (def.merge !== "union") {
    throw new Error(
      `Expected "${IOS_ADDITIONAL_DEVICE_SETS_KEY}" to use the "union" merge preset; ` +
        "update getAdditionalIosDeviceSets to match the new policy."
    );
  }
  const home = resolveHomeDir(options);
  const global = resolveDeviceSetEntries(readScopeValue(def, "global", options), home, home);
  const project = resolveDeviceSetEntries(
    readScopeValue(def, "project", options),
    resolveProjectRoot(options.cwd ?? process.cwd()),
    home
  );
  return Array.from(new Set([...global, ...project]));
}

function resolveDeviceSetEntries(
  entries: string[] | undefined,
  baseDir: string,
  home: string
): string[] {
  if (!entries || entries.length === 0) return [];
  return entries.map((entry) => {
    if (entry === "~") return path.resolve(home);
    if (entry.startsWith("~/")) return path.resolve(home, entry.slice(2));
    return path.resolve(baseDir, entry);
  });
}
