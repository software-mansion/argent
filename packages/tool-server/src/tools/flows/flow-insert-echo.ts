import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { requireRecordingSession, appendStepToFlow, type FlowSavedTo } from "./flow-utils";

const zodSchema = z.object({
  name: z
    .string()
    .describe("Name of the flow being recorded — the one passed to flow-start-recording."),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root of the flow being recorded — the same value passed to flow-start-recording. Together with `name` it identifies which recording this echo belongs to."
    ),
  message: z.string().describe("Message to echo when the flow is replayed"),
});

export const flowInsertEchoTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; stepCount: number; savedTo: FlowSavedTo }
> = {
  id: "flow-add-echo",
  interaction: {
    // Name the flow: recordings are concurrent, so several of these lines can
    // interleave in one log and "the recorded flow" would not identify which.
    startedMsg: ({ params }) => `Adding note to flow ${params.name}`,
    completedMsg: ({ params }) => `Added note to flow ${params.name}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to add note to flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Record an echo step in the flow named by \`name\` + \`project_root\`. Echo steps print a message when the flow is replayed — useful as labels between tool calls.
Use when you want to annotate a recorded flow with a human-readable label or checkpoint message.
Returns { message, stepCount, savedTo } - \`stepCount\` is how many steps the flow now has, and \`savedTo\` is where the YAML landed: a host path, or, against a remote client, the directive that has the client write it (the only field naming the destination in that mode). The flow's full YAML is deliberately NOT returned per step; read it back from \`flow-finish-recording\`. Fails if that flow has no recording in progress.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const session = await requireRecordingSession(params.project_root, params.name);

    const { savedTo } = await appendStepToFlow(session, {
      kind: "echo",
      message: params.message,
    });

    return {
      message: `Echo added to "${params.name}" flow`,
      stepCount: session.flow.steps.length,
      savedTo,
    };
  },
};
