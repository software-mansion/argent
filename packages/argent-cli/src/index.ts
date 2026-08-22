export { run, type RunCommandOptions } from "./run.js";
export { flow, type FlowCommandOptions } from "./flow.js";
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
