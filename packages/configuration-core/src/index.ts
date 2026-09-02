export {
  FLAG_REGISTRY,
  getFlagDefinition,
  findProjectRoot,
  resolveProjectRoot,
  getFlagsPath,
  readFlags,
  setFlag,
  unsetFlag,
  isFlagEnabled,
  isFeatureEnabled,
  type FlagScope,
  type FlagDefinition,
  type FlagsPathOptions,
} from "./flags.js";

export {
  argentHomeDir,
  resolveHomeDir,
  configDir,
  configFilePath,
  type ConfigPathOptions,
} from "./paths.js";

export { readConfigObject, updateConfig, getAtPath, setAtPath, deleteAtPath } from "./config.js";

// Ordered environment + dotenv-file chain that `{{secret:…}}` placeholders and
// `argent secrets` resolve names through.
export {
  secretSources,
  lookupSecret,
  secretNames,
  describeSecretSources,
  secretPlacementAdvice,
  SECRET_ENV_PREFIX,
  type SecretSource,
  type SecretSourceOptions,
} from "./secrets.js";

export {
  applyMergePolicy,
  MERGE_PRESETS,
  type MergePreset,
  type MergeFn,
  type MergePolicy,
  type MergeInputs,
} from "./merge.js";

export {
  CONFIG_SCHEMA,
  describeExpectedValue,
  getConfigDefinition,
  asBoolean,
  asString,
  asNumber,
  asPositiveInteger,
  asStringArray,
  MIN_SCRIPT_HEAP_LIMIT_MB,
  MIN_SCRIPT_TIMEOUT_MS,
  WINDOWS_ROOTED_PATH_RE,
  type ConfigDefinition,
} from "./config-schema.js";

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
  getAdditionalIosDeviceSets,
  UnknownConfigKeyError,
  ConfigScopeError,
  ConfigValidationError,
  ConfigManagedElsewhereError,
  type ConfigEntryView,
} from "./config-access.js";
