// The ONE integration seam. argent's setup-registry calls registerNickel(registry)
// behind the "nickel" feature flag — this registers the runtime blueprint + the
// Nickel tools. Nothing else in argent changes.

import type { Registry } from "@argent/registry";
import { llamaRuntimeBlueprint } from "./runtime/llama-runtime";
import { createNickelActTool } from "./tools/nickel-act";
import { createNickelLookTool } from "./tools/nickel-look";
import { createNickelDoTool } from "./tools/nickel-do";

export function registerNickel(registry: Registry): void {
  registry.registerBlueprint(llamaRuntimeBlueprint);
  registry.registerTool(createNickelActTool(registry));
  registry.registerTool(createNickelLookTool(registry));
  registry.registerTool(createNickelDoTool(registry));
}
