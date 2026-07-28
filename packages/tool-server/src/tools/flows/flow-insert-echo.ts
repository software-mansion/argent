import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { getActiveFlow, appendStepToActiveFlow, type FlowSavedTo } from "./flow-utils";

const zodSchema = z.object({
  message: z.string().describe("Message to echo when the flow is replayed"),
});

export const flowInsertEchoTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; flowFile: string; savedTo: FlowSavedTo }
> = {
  id: "flow-add-echo",
  interaction: {
    startedMsg: () => "Adding note to recorded flow",
    completedMsg: () => "Added note to recorded flow",
    failedMsg: ({ failureSignal }) =>
      `Failed to add note to recorded flow: ${failureSignal.error_code}`,
  },
  description: `Record an echo step in the active flow. Echo steps print a message when the flow is replayed — useful as labels between tool calls.
Use when you want to annotate a recorded flow with a human-readable label or checkpoint message.
Returns { message, flowFile }. Fails if no active flow recording is in progress.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const flowName = getActiveFlow();

    const { flowFile, savedTo } = await appendStepToActiveFlow({
      kind: "echo",
      message: params.message,
    });

    return {
      message: `Echo added to "${flowName}" flow`,
      flowFile,
      savedTo,
    };
  },
};
