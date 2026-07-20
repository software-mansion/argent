export { run, type RunCommandOptions } from "./run.js";
export { flow, type FlowCommandOptions } from "./flow.js";
export { tools, type ToolsCommandOptions } from "./tools.js";
export { server } from "./server.js";
export { lens, type LensCommandOptions } from "./lens.js";
export { map, type MapCommandOptions } from "./map.js";
export { enable, disable, flags } from "./flags.js";
export { link, unlink } from "./link.js";
// Backward-compat re-export: the flag primitives now live in
// @argent/configuration-core, but @argent/cli's public surface keeps exposing
// them so existing importers (and the publish bundle) are unaffected.
export {
  isFlagEnabled,
  getFlagDefinition,
  FLAG_REGISTRY,
  type FlagScope,
  type FlagDefinition,
} from "@argent/configuration-core";
export { telemetry } from "./telemetry.js";
