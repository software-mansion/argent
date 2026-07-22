export {
  FLAG_REGISTRY,
  getFlagDefinition,
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

export { argentHomeDir, configFilePath } from "./paths.js";

export {
  readConfigObject,
  updateConfig,
  getRememberedAgent,
  setRememberedAgent,
  clearRememberedAgent,
} from "./config.js";
