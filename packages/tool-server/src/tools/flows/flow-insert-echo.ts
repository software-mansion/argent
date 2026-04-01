import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { getFlowPath, getActiveFlow, appendStep } from "./flow-utils";

const zodSchema = z.object({
  message: z.string().describe("Message to echo when the flow is replayed"),
});

export const flowInsertEchoTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; flowFile: string }
> = {
  id: "flow-add-echo",
  description: `Add an echo (label) step to the active flow recording that prints a message during replay.
Use when you want to annotate a flow with progress markers like "Navigated to Settings" or "Login complete" for clarity during replay.

Parameters: message — the label text to print during replay (e.g. "Tapping the login button").
Example: { "message": "Entering credentials" }
Returns { message, flowFile }. Echo steps do not execute any tool; they only print text during replay. Fails if no active recording session exists (error: "no active flow") — call flow-start-recording first.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const flowName = getActiveFlow();
    const filePath = await getFlowPath(flowName);

    const flowFile = await appendStep(filePath, {
      kind: "echo",
      message: params.message,
    });

    return {
      message: `Echo added to "${flowName}" flow`,
      flowFile,
    };
  },
};
