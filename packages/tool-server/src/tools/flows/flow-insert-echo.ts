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
  description: `Record an echo step in the active flow. Echo steps print a message when the flow is replayed — useful as labels between tool calls.
Use when you want to annotate a recorded flow with a human-readable label or checkpoint message.
Returns { message, flowFile }. Fails if no active flow recording is in progress.`,
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
