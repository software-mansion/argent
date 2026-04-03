import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import { getFlowPath, getActiveFlow, appendStep } from "./flow-utils";

const zodSchema = z.object({
  command: z.string().describe('MCP tool name (e.g. "tap", "screenshot", "launch-app")'),
  args: z
    .string()
    .optional()
    .describe(
      'Tool arguments as a JSON string, e.g. \'{"udid": "ABC", "x": 0.5, "y": 0.3}\'. Omit for tools with no arguments.'
    ),
});

export function createFlowAddStepTool(
  registry: Registry
): ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; toolResult: unknown; flowFile: string }
> {
  return {
    id: "flow-add-step",
    description: `Execute a tool call and record it as a step in the active flow.\nThe tool call is run immediately. If it succeeds the step is recorded; if it fails an error is returned and nothing is recorded.\nIf a step was recorded by mistake, edit the .yaml file directly to remove it.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const flowName = getActiveFlow();
      const filePath = await getFlowPath(flowName);
      const args: Record<string, unknown> = params.args ? JSON.parse(params.args) : {};

      const toolResult = await registry.invokeTool(params.command, args);

      const flowFile = await appendStep(filePath, {
        kind: "tool",
        name: params.command,
        args,
      });

      return {
        message: `Step added to "${flowName}" flow`,
        toolResult,
        flowFile,
      };
    },
  };
}
