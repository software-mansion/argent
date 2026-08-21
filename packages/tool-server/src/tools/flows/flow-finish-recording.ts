import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import {
  requireRecordingSession,
  clearRecordingSession,
  withFlowFileLock,
  clientFileDirective,
  parseFlow,
  serializeFlow,
  type FlowSavedTo,
} from "./flow-utils";
import { summarizeSteps } from "./flow-step-definitions";

const zodSchema = z.object({
  name: z
    .string()
    .describe("Name of the flow being recorded — the one passed to flow-start-recording."),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root of the flow being recorded — the same value passed to flow-start-recording. Together with `name` it identifies which recording to finish."
    ),
});

export const flowFinishRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    message: string;
    path: string;
    executionPrerequisite: string;
    steps: number;
    summary: string[];
    flowFile: string;
    savedTo: FlowSavedTo;
  }
> = {
  id: "flow-finish-recording",
  interaction: {
    // Name the flow: other recordings stay live across this call, so an
    // unqualified "Finishing flow recording" would not identify which one.
    startedMsg: ({ params }) => `Finishing recording of flow ${params.name}`,
    // `params.name` rather than the basename of `result.path`: the two are the
    // same string on every branch — `assertSafeFlowName` admits no dots or
    // separators, so `getFlowPath` produces `<name>.yaml` and nothing else —
    // and this spelling matches the two formatters either side of it.
    completedMsg: ({ params }) => `Saved recorded flow ${params.name}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to finish recording of flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Finish recording the flow named by \`name\` + \`project_root\`, leaving recordings under any other key untouched. Returns { message, path, executionPrerequisite, steps, summary, flowFile, savedTo } - a summary of all recorded steps plus the final YAML. Use when you have added all desired steps and want to finalize the flow file. Fails if that flow has no recording in progress.
You can still edit the .yaml file directly afterwards to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    // Resolve, read and clear as ONE critical section under the flow-file lock.
    // Host mode's `await fs.readFile` is a yield, and an append that lands in it
    // would be on disk while the summary and step count reported here — taken
    // from the pre-append read — say otherwise.
    const { filePath, flowFile, savedTo, flow, summary } = await withFlowFileLock(
      params.project_root,
      params.name,
      async () => {
        const session = await requireRecordingSession(params.project_root, params.name);

        // Host mode re-reads the file so manual edits made during the recording
        // survive into the summary; in client mode this host never has the file,
        // so the in-memory copy is the truth and travels back in the directive.
        const filePath = session.filePath;
        let flowFile: string;
        let savedTo: FlowSavedTo;
        if (session.persist === "client") {
          flowFile = serializeFlow(session.flow);
          savedTo = clientFileDirective(filePath, flowFile);
        } else {
          flowFile = await fs.readFile(filePath, "utf8");
          savedTo = filePath;
        }
        // Parse BEFORE clearing. Hand-editing the .yaml mid-recording is a
        // documented workflow, so parseFlow can legitimately throw here on a
        // botched edit — and clearing first would destroy the session on the
        // way out, leaving the agent unable to retry the finish after repairing
        // the file (the only tool that re-establishes the key,
        // flow-start-recording, truncates the take it would be recovering).
        const flow = parseFlow(flowFile);
        // Render the summary before clearing too, for the same reason: it walks
        // step bodies the parser does not fully constrain, and nothing that can
        // throw may run after the session is destroyed. The one known thrower
        // there — `JSON.stringify` on a cyclic `args` anchor — is guarded in
        // flow-step-definitions; keeping the order is what makes the next one
        // recoverable rather than fatal.
        const summary = summarizeSteps(flow);
        clearRecordingSession(session);
        return { filePath, flowFile, savedTo, flow, summary };
      }
    );

    return {
      message: `Finished recording "${params.name}" flow (${flow.steps.length} steps)`,
      path: filePath,
      executionPrerequisite: flow.executionPrerequisite,
      steps: flow.steps.length,
      summary,
      flowFile,
      savedTo,
    };
  },
};
