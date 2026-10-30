import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { requireRecordingSession, appendStepToFlow, type FlowSavedTo } from "./flow-utils";

const zodSchema = z.object({
  name: z
    .string()
    .describe("Name of the e2e test being recorded: the one passed to e2e-start-recording."),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root of the e2e test being recorded: the same value passed to e2e-start-recording. Together with `name` it identifies which recording this echo belongs to."
    ),
  message: z.string().describe("Message to echo when the e2e test is replayed"),
});

export const flowInsertEchoTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; stepCount: number; savedTo: FlowSavedTo }
> = {
  id: "e2e-add-echo",
  aliases: ["flow-add-echo"],
  interaction: {
    // Name the flow: recordings are concurrent, so an unqualified message is ambiguous.
    startedMsg: ({ params }) => `Adding note to e2e test ${params.name}`,
    completedMsg: ({ params }) => `Added note to e2e test ${params.name}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to add note to e2e test ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Record an echo step in the e2e test named by \`name\` + \`project_root\`. Echo steps print a message when the e2e test is replayed, useful as labels between tool calls.
Use when you want to annotate a recorded e2e test with a human-readable label or checkpoint message.
Returns { message, stepCount, savedTo }. Fails if that e2e test has no recording in progress.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const session = await requireRecordingSession(params.project_root, params.name);

    const { savedTo, stepCount } = await appendStepToFlow(session, {
      kind: "echo",
      message: params.message,
    });

    return {
      message: `Echo added to "${params.name}" e2e test`,
      stepCount,
      savedTo,
    };
  },
};
