import { Registry, type ToolDefinition } from "@argent/registry";
import { simulatorServerBlueprint } from "../blueprints/simulator-server";
import { nativeDevtoolsBlueprint } from "../blueprints/native-devtools";
import { androidDevtoolsBlueprint } from "../blueprints/android-devtools";
import { axServiceBlueprint } from "../blueprints/ax-service";
import { jsRuntimeDebuggerBlueprint } from "../blueprints/js-runtime-debugger";
import { networkInspectorBlueprint } from "../blueprints/network-inspector";
import { reactProfilerSessionBlueprint } from "../blueprints/react-profiler-session";
import { nativeProfilerSessionBlueprint } from "../blueprints/native-profiler-session";
import { createAllTools } from "../tools-manifest";

export function createRegistry(): Registry {
  const registry = new Registry();

  registry.registerBlueprint(simulatorServerBlueprint);
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerBlueprint(networkInspectorBlueprint);
  registry.registerBlueprint(reactProfilerSessionBlueprint);
  registry.registerBlueprint(nativeProfilerSessionBlueprint);
  registry.registerBlueprint(nativeDevtoolsBlueprint);
  registry.registerBlueprint(androidDevtoolsBlueprint);
  registry.registerBlueprint(axServiceBlueprint);

  for (const tool of Object.values(createAllTools(registry))) {
    registry.registerTool(tool as ToolDefinition<unknown, unknown>);
  }

  return registry;
}
