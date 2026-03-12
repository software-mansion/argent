import { z } from "zod";
import * as fs from "node:fs/promises";
import type { Registry, ToolDefinition } from "@argent/registry";
import { getFlowPath, getActiveFlow, serializeStep } from "./flow-utils";

const zodSchema = z.object({
  command: z.string().describe("MCP tool name (e.g. \"tap\", \"screenshot\", \"launch-app\")"),
  args: z
    .record(z.unknown())
    .optional()
    .describe('Tool arguments as a JSON object, e.g. {"udid": "...", "x": 0.5, "y": 0.3}'),
});

export function createFlowAddStepTool(
  registry: Registry,
): ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; toolResult: unknown; flowFile: string }
> {
  return {
    id: "flow_add_step",
    description: `Execute a tool call and record it as a step in the active flow.

The tool call is run immediately. If it succeeds the step is recorded; if it
fails an error is returned and nothing is recorded.

If a step was recorded by mistake, edit the .flow file by hand to remove it.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const flowName = getActiveFlow();
      const filePath = await getFlowPath(flowName);
      const args = (params.args ?? {}) as Record<string, unknown>;

      // Execute the tool call live first
      const toolResult = await registry.invokeTool(params.command, args);

      // Only record on success
      const line = serializeStep({
        kind: "tool",
        name: params.command,
        args,
      });
      await fs.appendFile(filePath, line + "\n", "utf8");

      const flowFile = await fs.readFile(filePath, "utf8");
      return {
        message: `Step added to "${flowName}" flow`,
        toolResult,
        flowFile,
      };
    },
  };
}
