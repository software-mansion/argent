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
  description: `Add an echo step to the active flow. Use when you want to insert a human-readable label between tool calls, e.g. "Navigating to settings". Parameters: message (string label to print on replay). Returns { message, flowFile }. Fails if no flow recording is active. Echo steps print the message when the flow is replayed — useful as section labels between tool calls.`,
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
