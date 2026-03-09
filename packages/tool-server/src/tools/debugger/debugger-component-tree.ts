import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { COMPONENT_TREE_SCRIPT } from "../../utils/debugger/scripts/component-tree";

interface ComponentEntry {
  id: number;
  name: string;
  depth: number;
  rect: { x: number; y: number; w: number; h: number } | null;
  isHost: boolean;
  parentIdx: number;
}

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
});

export const debuggerComponentTreeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { components: ComponentEntry[] } | { error: string }
> = {
  id: "debugger-component-tree",
  description: `Return the full React component tree with names, depth, and native bounding rectangles.
Each entry has: id, name, depth, rect (x/y/w/h or null), isHost (native vs composite), parentIdx.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const raw = await api.cdp.evaluate(COMPONENT_TREE_SCRIPT);

    if (typeof raw !== "string") {
      return { error: "No result from component tree script" };
    }

    const parsed = JSON.parse(raw);
    if (parsed.error) {
      return { error: parsed.error };
    }

    return { components: parsed as ComponentEntry[] };
  },
};
