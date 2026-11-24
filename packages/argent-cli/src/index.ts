export { run, type RunCommandOptions } from "./run.js";
// `flow` is the former name of `e2e`, kept as a silent alias.
export { e2e, e2e as flow, type E2eCommandOptions, type FlowCommandOptions } from "./e2e.js";
export { tools, type ToolsCommandOptions } from "./tools.js";
export { server } from "./server.js";
export { lens, type LensCommandOptions } from "./lens.js";
export { enable, disable, flags } from "./flags.js";
export { config } from "./config.js";
export { secrets } from "./secrets.js";
export { link, unlink } from "./link.js";
// Re-exported for backward compat: these moved to @argent/configuration-core.
export {
  isFlagEnabled,
  getFlagDefinition,
  FLAG_REGISTRY,
  type FlagScope,
  type FlagDefinition,
} from "@argent/configuration-core";
export { telemetry } from "./telemetry.js";
export { providers } from "./providers.js";
