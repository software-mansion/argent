import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import { getActiveFlow, appendStepToActiveFlow, type FlowSavedTo } from "./flow-utils";
import { invokeSubTool } from "../../utils/sub-invoke";

const zodSchema = z.object({
  command: z.string().describe('MCP tool name (e.g. "gesture-tap", "screenshot", "launch-app")'),
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
  { message: string; toolResult: unknown; flowFile: string; savedTo: FlowSavedTo }
> {
  return {
    id: "flow-add-step",
    description: `Execute a tool call live and record it as a step in the active flow unless the tool throws. Use when recording a flow with flow-start-recording and you want to run and capture each action. Returns { message, toolResult, flowFile } after recording. Tool results that report failure as data, such as find returning { found: false }, are still recorded; inspect toolResult before continuing and edit the .yaml file to remove mistaken steps. If the tool throws, an error is returned and nothing is recorded. Error if the tool name is not found in the registry or arguments are invalid JSON.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params, ctx) {
      const flowName = getActiveFlow();
      const args: Record<string, unknown> = params.args ? JSON.parse(params.args) : {};

      const toolResult = await invokeSubTool(registry, ctx, params.command, args);

      const { flowFile, savedTo } = await appendStepToActiveFlow({
        kind: "tool",
        name: params.command,
        args,
        delayMs: params.delayMs,
      });

      return {
        message: `Step added to "${flowName}" flow`,
        toolResult,
        flowFile,
        savedTo,
      };
    },
  };
}
