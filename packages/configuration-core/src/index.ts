export {
  FLAG_REGISTRY,
  getFlagDefinition,
  resolveProjectRoot,
  getFlagsPath,
  readFlags,
  setFlag,
  unsetFlag,
  isFlagEnabled,
  type FlagScope,
  type FlagDefinition,
  type FlagsPathOptions,
} from "./flags.js";

export { argentHomeDir, configDir, configFilePath, type ConfigPathOptions } from "./paths.js";

export { readConfigObject, updateConfig, getAtPath, setAtPath, deleteAtPath } from "./config.js";

// Merge policies for scoped values.
export {
  applyMergePolicy,
  MERGE_PRESETS,
  type MergePreset,
  type MergeFn,
  type MergePolicy,
  type MergeInputs,
} from "./merge.js";

// The configuration schema: the registry of recognized values + parse helpers.
export {
  CONFIG_SCHEMA,
  getConfigDefinition,
  asBoolean,
  asString,
  asNumber,
  asStringArray,
  type ConfigDefinition,
} from "./config-schema.js";

// Schema-driven read/write, plus the migrated lens getters.
export {
  getConfigValue,
  getConfigValueByKey,
  getConfigValueAtScope,
  setConfigValue,
  unsetConfigValue,
  listConfig,
  coerceCliValue,
  getRememberedAgent,
  setRememberedAgent,
  clearRememberedAgent,
  UnknownConfigKeyError,
  ConfigScopeError,
  ConfigValidationError,
  ConfigManagedElsewhereError,
  type ConfigEntryView,
} from "./config-access.js";
