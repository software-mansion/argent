import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import { getFlowPath, getActiveFlow, appendStep, type FlowStep } from "./flow-utils";

const zodSchema = z.object({
  command: z.string().describe('MCP tool name (e.g. "tap", "screenshot", "launch-app")'),
  args: z
    .string()
    .optional()
    .describe(
      'Tool arguments as a JSON string, e.g. \'{"udid": "ABC", "x": 0.5, "y": 0.3}\'. Omit for tools with no arguments.'
    ),
  delayMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Milliseconds to sleep before executing this step during replay."),
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
      const filePath = getFlowPath(flowName);
      const args: Record<string, unknown> = params.args ? JSON.parse(params.args) : {};

      const toolResult = await registry.invokeTool(params.command, args);

      const step: FlowStep = { kind: "tool", name: params.command, args };
      if (params.delayMs !== undefined) step.delayMs = params.delayMs;
      const flowFile = await appendStep(filePath, step);

      return {
        message: `Step added to "${flowName}" flow`,
        toolResult,
        flowFile,
      };
    },
  };
}
