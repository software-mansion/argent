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
  type FlowStep,
  type FlowSavedTo,
  type RecordedStepWarning,
  type RecordingSession,
} from "./flow-utils";
import { stepAnchor, summarizeSteps } from "./flow-step-definitions";

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

/**
 * Fold each recorded step's cross-tree verdict into its own summary line.
 *
 * The probe raises the verdict on one step's `message`, but it answers a
 * POLISH-time question, and polish begins here. A warning raised at step 7 of a
 * 40-step recording has otherwise scrolled out of reach by the time it is
 * actionable, and no artifact carries it.
 *
 * The verdict gets its own ARRAY ELEMENT, not a newline inside the step's line:
 * this tool has no bespoke MCP renderer, so `JSON.stringify` would escape an
 * embedded newline and deliver the verdict inside one long string. The indent
 * and the `warning:` prefix keep it attached to the step above.
 *
 * {@link anchoredWarnings} decides which verdicts survive to be folded in.
 */
function attachStepWarnings(
  summary: string[],
  warnings: Map<number, RecordedStepWarning>
): string[] {
  if (warnings.size === 0) return summary;
  return summary.flatMap((line, i) => {
    const recorded = warnings.get(i + 1);
    return recorded ? [line, `   warning: ${recorded.warning}`] : [line];
  });
}

/**
 * What `message` says about the warnings the summary carries, by KIND — and
 * about the ones it does NOT carry.
 *
 * The two kinds are different news, and only one is about conversion. A wait
 * that came back `success: false` was never probed: it failed live, and at
 * replay it stops the run. Counting it as a conversion warning states the
 * opposite of the actionable fact.
 *
 * `discarded` is what the anchor checks threw away. Dropping is the right
 * answer, but reporting it as a pass is not: a recording where every wait
 * diverged would otherwise return the same payload as a clean one.
 */
function warningHeadline(warnings: Map<number, RecordedStepWarning>, discarded: number): string {
  const counts = { conversion: 0, wait: 0 };
  for (const { kind } of warnings.values()) counts[kind] += 1;
  const clauses: string[] = [];
  if (counts.conversion > 0) {
    clauses.push(
      `${counts.conversion} ${counts.conversion === 1 ? "step carries" : "steps carry"} a ` +
        `cross-tree warning about converting a recorded wait`
    );
  }
  if (counts.wait > 0) {
    clauses.push(
      `${counts.wait} ${counts.wait === 1 ? "step" : "steps"} recorded a wait that did not pass`
    );
  }
  const carried =
    clauses.length === 0
      ? ""
      : ` — ${clauses.join(", and ")}; read \`summary\` before converting or replaying`;
  if (discarded === 0) return carried;
  const one = discarded === 1;
  const drop =
    `${discarded} ${one ? "warning" : "warnings"} raised during this recording ${one ? "is" : "are"} ` +
    `NOT in \`summary\`: a hand edit to the .yaml moved the ${one ? "step it judged" : "steps they judged"}, ` +
    `so which step ${one ? "it belongs" : "they belong"} to is no longer knowable — re-record ` +
    `${one ? "that wait" : "those waits"} to see ${one ? "it" : "them"} again`;
  return carried === "" ? ` — ${drop}` : `${carried}. ${drop}`;
}

/**
 * The verdicts still anchored to the steps they judged.
 *
 * An anchor is a POSITION, and a mid-recording hand edit moves positions. A
 * verdict left on its old number would convict whichever step inherited it,
 * while the real risk reads clean. Two checks, because one edit can defeat
 * either alone:
 *
 * 1. The finished flow must still be the file the recorder saw. This catches an
 *    edit made after the last append. It compares step CONTENT, so an ordinary
 *    append that files no verdict does not read as an edit.
 * 2. Each verdict's own step must still occupy its number.
 *
 * A verdict that fails check 2 is dropped rather than re-anchored: which step
 * moved where is unknowable from here.
 *
 * An edit the recorder then appended OVER is invisible to both checks, because
 * that append re-read the edited file into `session.flow`. `appendStepToFlow`
 * settles that case while both views still exist — see `dropMovedWarnings` in
 * flow-utils.
 */
function anchoredWarnings(
  session: RecordingSession,
  steps: FlowStep[]
): Map<number, RecordedStepWarning> {
  const kept = new Map<number, RecordedStepWarning>();
  const recorded = session.flow.steps;
  if (recorded.length !== steps.length) return kept;
  if (!steps.every((step, i) => stepAnchor(step) === stepAnchor(recorded[i]))) return kept;
  for (const [n, verdict] of session.stepWarnings ?? []) {
    // `steps[n - 1]` is defined on every reachable path; the guard is a
    // fail-safe. `stepAnchor(undefined)` would throw inside the finish's
    // critical section and lose the whole recording rather than one warning.
    const step = steps[n - 1];
    if (step !== undefined && stepAnchor(step) === verdict.step) kept.set(n, verdict);
  }
  return kept;
}

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
    // Name the flow: other recordings stay live, so an unqualified message would
    // not identify which one.
    startedMsg: ({ params }) => `Finishing recording of flow ${params.name}`,
    // `params.name` equals the basename of `result.path` on every branch
    // (`assertSafeFlowName` admits no dots or separators), and matches the two
    // formatters either side.
    completedMsg: ({ params }) => `Saved recorded flow ${params.name}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to finish recording of flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Finish recording the flow named by \`name\` + \`project_root\`, leaving recordings under any other key untouched. Returns { message, path, executionPrerequisite, steps, summary, flowFile, savedTo } - a summary of all recorded steps plus the final YAML. Use when you have added all desired steps and want to finalize the flow file. Fails if that flow has no recording in progress.
A warning flow-add-step raised on a recorded \`await-ui-element\` is repeated in \`summary\` as a \`warning:\` line of its own, right below the step it judges, and \`message\` counts them by kind. A warning is repeated only while the step it judges is still identifiable by its number: hand-editing the .yaml during the recording moves the steps, so those warnings are DROPPED rather than pinned on whichever step inherited the number, and \`message\` says how many were dropped. A step that carries a cross-tree warning was re-probed against the runner's tree: read it before converting that wait to \`await:\`/\`assert:\`, which is what the verdict is about and what this moment is for. A step that recorded a wait which did not pass was never probed at all, and its own warning names the CAUSE, because only one of them judges the condition: an unmet wait was read and found false, and it stops the run at replay; a wait whose tree source could not be read, or one that was cancelled, observed nothing and leaves the condition UNKNOWN rather than known-bad. Read those before replaying.
You can still edit the .yaml file directly afterwards to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    // Resolve, read and clear as ONE critical section: host mode's
    // `await fs.readFile` is a yield, and an append landing in it would be on
    // disk while the summary and step count — taken from the pre-append read —
    // say otherwise.
    const { filePath, flowFile, savedTo, flow, summary, headline } = await withFlowFileLock(
      params.project_root,
      params.name,
      async () => {
        const session = await requireRecordingSession(params.project_root, params.name);

        // Host mode re-reads so manual edits made during the recording reach the
        // summary; in client mode this host never has the file, so the in-memory
        // copy is the truth and travels back in the directive.
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
        // Parse BEFORE clearing: nothing STOPS a mid-recording hand edit (the
        // recording tools only tell the agent to edit after the finish), so
        // parseFlow can throw on a botched one, and clearing first would
        // destroy the session — leaving no way to retry the finish after
        // repairing the file (flow-start-recording, the only tool that
        // re-establishes the key, truncates the take it would recover).
        const flow = parseFlow(flowFile);
        // Summarize before clearing for the same reason: it walks step bodies the
        // parser does not fully constrain, and nothing that can throw may run
        // after the session is destroyed. The one known thrower —
        // `JSON.stringify` on a cyclic `args` anchor — is guarded in
        // flow-step-definitions; keeping the order is what makes the next one
        // recoverable rather than fatal.
        const anchored = anchoredWarnings(session, flow.steps);
        const summary = attachStepWarnings(summarizeSteps(flow), anchored);
        // Everything raised, less what survived. `discardedWarnings` counts
        // what the appends threw away; `stepWarnings` what the finish still
        // held.
        const discarded =
          (session.discardedWarnings ?? 0) + (session.stepWarnings?.size ?? 0) - anchored.size;
        const headline = warningHeadline(anchored, discarded);
        clearRecordingSession(session);
        return { filePath, flowFile, savedTo, flow, summary, headline };
      }
    );

    return {
      // Name the counts in `message` as well. A caller that reads only
      // `message` would otherwise polish blind.
      message: `Finished recording "${params.name}" flow (${flow.steps.length} steps)` + headline,
      path: filePath,
      executionPrerequisite: flow.executionPrerequisite,
      steps: flow.steps.length,
      summary,
      flowFile,
      savedTo,
    };
  },
};
