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
    description: `Execute a tool call immediately and, if it succeeds, record it as a step in the active flow.
Use when building a flow step-by-step — each call is executed live so you can verify it works before it is recorded. Call flow-start-recording first to begin a recording session.

Parameters: command — MCP tool name (e.g. "gesture-tap", "screenshot", "launch-app"); args — tool arguments as a JSON string (e.g. '{"udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "x": 0.5, "y": 0.3}').
Example: { "command": "gesture-tap", "args": "{\"udid\": \"A1B2C3D4-E5F6-7890-ABCD-EF1234567890\", \"x\": 0.5, \"y\": 0.25}" }
Returns { message, toolResult, flowFile }. If the tool call fails, an error is returned and nothing is recorded. To remove a mistakenly recorded step, edit the .yaml file directly. Throws if no active recording session — call flow-start-recording first.`,
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
