import { z } from "zod";
import * as fs from "node:fs/promises";
import type { Registry, ToolDefinition } from "@argent/registry";
import { getFlowPath, serializeStep } from "./flow-utils";

const zodSchema = z.object({
  flow: z.string().describe("Flow name to append to (e.g. \"settings-explore\")"),
  tool: z.string().describe("MCP tool to call (e.g. \"tap\", \"screenshot\", \"launch-app\")"),
  args: z
    .record(z.unknown())
    .optional()
    .describe('Tool arguments as a JSON object, e.g. {"udid": "...", "x": 0.5, "y": 0.3}'),
});

export function createFlowAddStepTool(
  registry: Registry,
): ToolDefinition<
  z.infer<typeof zodSchema>,
  { appended: string; toolResult: unknown; flowFile: string }
> {
  return {
    id: "flow_add_step",
    description: `Append a tool-call step to an existing flow AND execute it live.

The tool call is run immediately via the registry. If it succeeds the step is
recorded in the flow file; if it fails an error is returned and nothing is
recorded. This way you can verify every step works before it becomes part of
the flow.

If a step was recorded by mistake, you can always edit the .flow file by hand
afterwards to remove or reorder lines.

Returns the live tool result AND the current contents of the flow file.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const filePath = await getFlowPath(params.flow);
      const args = (params.args ?? {}) as Record<string, unknown>;

      // Execute the tool call live first
      const toolResult = await registry.invokeTool(params.tool, args);

      // Only record on success
      const line = serializeStep({
        kind: "tool",
        name: params.tool,
        args,
      });
      await fs.appendFile(filePath, line + "\n", "utf8");

      const flowFile = await fs.readFile(filePath, "utf8");
      return { appended: line, toolResult, flowFile };
    },
  };
}
