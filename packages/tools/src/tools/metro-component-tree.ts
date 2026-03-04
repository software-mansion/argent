import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import type { MetroDebuggerApi } from "../blueprints/metro-debugger";
import { COMPONENT_TREE_SCRIPT } from "../metro/scripts/component-tree";

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

export const metroComponentTreeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { components: ComponentEntry[] } | { error: string }
> = {
  id: "metro-component-tree",
  description: `Return the full React component tree with names, depth, and native bounding rectangles.
Each entry has: id, name, depth, rect (x/y/w/h or null), isHost (native vs composite), parentIdx.`,
  zodSchema,
  services: (params) => ({
    metroDebugger: `MetroDebugger:${params.port}`,
  }),
  async execute(services) {
    const api = services.metroDebugger as MetroDebuggerApi;
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
