import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import { getFlowPath, getActiveFlow, appendStep } from "./flow-utils";

const zodSchema = z.object({
  command: z.string().describe('MCP tool name (e.g. "tap", "screenshot", "launch-app")'),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory (same path passed to flow-start-recording)."
    ),
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
    description: `Execute a tool call and record it as a step in the active flow. Use when recording a flow with flow-start-recording and you want to run and capture each action. Returns { message, toolResult, flowFile } on success. If it fails an error is returned and nothing is recorded. Error if the tool name is not found in the registry or arguments are invalid JSON.\nIf a step was recorded by mistake, edit the .yaml file directly to remove it.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const flowName = getActiveFlow();
      const filePath = getFlowPath(params.project_root, flowName);
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
