import { z } from "zod";
import {
  FAILURE_CODES,
  getFailureSignal,
  wrapFailure,
  type ToolDefinition,
} from "@argent/registry";
import {
  requireRecordingSession,
  appendStepToFlow,
  refusesOutputReferences,
  resolveStepReferences,
  type FlowSavedTo,
  type FlowStep,
} from "./flow-utils";

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
    // Name the flow: recordings are concurrent, so an unqualified message is ambiguous.
    startedMsg: ({ params }) => `Adding note to flow ${params.name}`,
    completedMsg: ({ params }) => `Added note to flow ${params.name}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to add note to flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Record an echo step in the flow named by \`name\` + \`project_root\`. Echo steps print a message when the flow is replayed — useful as labels between tool calls.
Use when you want to annotate a recorded flow with a human-readable label or checkpoint message.
Returns { message, stepCount, savedTo }. Fails if that flow has no recording in progress.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const session = await requireRecordingSession(params.project_root, params.name);

    const step: FlowStep = { kind: "echo", message: params.message };
    let savedTo: FlowSavedTo;
    let stepCount: number;
    try {
      ({ savedTo, stepCount } = await appendStepToFlow(session, step));
    } catch (err) {
      const stage = getFailureSignal(err)?.failure_stage;
      const fromTheFile = stage === "flow_file_parse" || stage === "flow_file_parse_step";
      if (stage !== "flow_output_reference" && !fromTheFile) throw err;
      throw wrapFailure(
        err,
        {
          error_code: FAILURE_CODES.FLOW_FILE_WRITE_FAILED,
          failure_stage: "flow_insert_echo_append",
          failure_area: "tool_server",
          error_kind: "unknown",
        },
        (!fromTheFile && refusesOutputReferences(step)
          ? `The echo was not recorded: its own \`message\` failed validation. `
          : `The echo was not recorded. Fix what is named below in ${session.filePath} — it is ` +
            `already in the file, not in this call. `) +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }

    // An echo starts nothing, so a path the recording's document lacks is no
    // reason to refuse it — a script recorded later may write that path. It is,
    // though, the one moment the agent can see a misspelled one.
    const resolved = resolveStepReferences(step, session.output);
    const warning = resolved.ok
      ? ""
      : ` — but its message does not resolve against the recording's output document: ` +
        `${resolved.reason}. At replay the echo errors and stops the run unless a script ` +
        `writes that path first`;
    return {
      message: `Echo added to "${params.name}" flow${warning}`,
      stepCount,
      savedTo,
    };
  },
};
