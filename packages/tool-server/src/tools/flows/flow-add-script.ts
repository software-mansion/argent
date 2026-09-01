import { z } from "zod";
import * as nodePath from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  wrapFailure,
  type ToolDefinition,
} from "@argent/registry";
import {
  appendStepToFlow,
  countStepsOnDisk,
  parseScriptPath,
  parseScriptTimeout,
  recordingSessionState,
  requireRecordingSession,
  type FlowSavedTo,
  type FlowStep,
  type RecordingSession,
} from "./flow-utils";
import { canonicalFlowPath } from "./flow-file-refs";
import { runFlowScriptStep, type ScriptRan } from "./flow-script-step";
import { utf8SafeCut } from "./script/flow-script-executor";
import { summarizeStep } from "./flow-finish-recording";

const OUTPUT_RENDER_LIMIT_BYTES = 64 * 1024;

const zodSchema = z.object({
  name: z
    .string()
    .describe("Name of the flow being recorded — the one passed to flow-start-recording."),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root of the flow being recorded — the same value passed to flow-start-recording. Together with `name` it identifies which recording this script step belongs to."
    ),
  path: z
    .string()
    .describe(
      'The .mjs file to run, relative to the flow file being recorded (`<project_root>/.argent/flows/<name>.yaml`) — so a script at `<project_root>/scripts/seed-order.mjs` is "../../scripts/seed-order.mjs". Forward slashes, lowercase .mjs; `..` is allowed. Recorded verbatim as the step\'s `path`.'
    ),
  timeout: z
    .number()
    .optional()
    .describe(
      "Hard time limit for the script, in milliseconds (default 30000, minimum 100, capped by the host's `scripts.maxTimeoutMs`). Below the minimum the step would spend the limit starting its own Node process, so it is refused here rather than run. Recorded verbatim as the step's `timeout`, so the run here and the replay share one limit."
    ),
});

interface FlowAddScriptResult {
  message: string;
  status: "pass" | "fail" | "error";
  reason?: string;
  durationMs?: number;
  /**
   * The document the script returned, as JSON text. Present only on a pass.
   *
   * Text rather than the parsed object: the client deep-walks every tool result
   * for `__argentClientFile` directives and `__argentArtifact` handles, both
   * matched on shape alone, and a script's document is the one part of a result
   * this server does not author.
   */
  outputJson?: string;
  outputTruncated?: true;
  stepCount: number;
  recorded?: string;
  savedTo?: FlowSavedTo;
}

/**
 * Steps in the recording, counted off the file — as {@link appendStepToFlow}
 * counts them on the success path. The session's in-memory copy only catches up
 * on each append, so a hand-edit made mid-recording would otherwise make the two
 * paths report counts of two different things.
 *
 * A file that will not read or parse leaves only that in-memory copy, which is a
 * count of a third thing again: the steps as of the last append. The number
 * still comes back, since nothing else in the answer depends on it, but it says
 * where it came from — the sibling recorder qualifies the same state the same
 * way, and a bare number here would be the one writer that does not.
 */
async function recordedStepCount(
  session: RecordingSession
): Promise<{ stepCount: number; note?: string }> {
  const onDisk = await countStepsOnDisk(session.filePath);
  if (onDisk !== undefined) return { stepCount: onDisk };
  return {
    stepCount: session.flow.steps.length,
    note:
      `${session.filePath} could not be read and parsed, so the step count is from the last ` +
      `valid in-memory snapshot rather than from the file.`,
  };
}

/**
 * How a failed call opens, and what it asks the author to do next. The two are
 * written as one entry because the lead may claim no more than the move below
 * it: an agent reads the first clause and stops, so a headline saying the
 * script could not be run answers "is there state to check?" with a no that the
 * rest of the same message then takes back.
 */
const FAILED_CALL: Record<ScriptRan, { lead: string; nextMove: string; leftBehind: string }> = {
  yes: {
    lead: "failed",
    nextMove:
      `Whatever the script did before it stopped is still done: nothing was rolled back, so ` +
      `either make the re-run safe to repeat or clean up first, then call this again.`,
    leftBehind:
      `Whatever the script did before it stopped is still done: nothing was rolled back, so ` +
      `clean up or make a re-run safe first.`,
  },
  no: {
    lead: "could not be run",
    nextMove: `Nothing ran, so there is nothing to clean up — the reason above says what stopped it.`,
    leftBehind: `Nothing ran, so there is nothing to clean up — the reason above says what stopped it.`,
  },
  unknown: {
    lead: "did not report a result",
    nextMove:
      `The runner failed around the script rather than inside it, so the script may never have ` +
      `started — check the state it touches before you call this again.`,
    leftBehind:
      `The runner failed around the script rather than inside it, so the script may never have ` +
      `started — check the state it touches.`,
  },
};

function renderOutput(output: Record<string, unknown>): {
  outputJson: string;
  outputTruncated?: true;
} {
  const encoded = JSON.stringify(output);
  const bytes = Buffer.from(encoded, "utf8");
  if (bytes.length <= OUTPUT_RENDER_LIMIT_BYTES) return { outputJson: encoded };
  const kept = bytes.subarray(0, utf8SafeCut(bytes, OUTPUT_RENDER_LIMIT_BYTES));
  return { outputJson: kept.toString("utf8"), outputTruncated: true };
}

export const flowAddScriptTool: ToolDefinition<z.infer<typeof zodSchema>, FlowAddScriptResult> = {
  id: "flow-add-script",
  interaction: {
    startedMsg: ({ params }) => `Running script for flow ${params.name}`,
    completedMsg: ({ params, result }) =>
      result.status === "pass"
        ? `Added script step to flow ${params.name}`
        : `Script for flow ${params.name} failed; nothing recorded`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to add script step to flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Run a local .mjs file and record it as a \`script:\` step in the flow named by \`name\` + \`project_root\` (the recording must already be open — see flow-start-recording). It runs the file the way a replay of THIS flow will. One divergence: the working directory is the ROOT run's \`project_root\`, so a flow in another project that composes this one with \`run:\` runs the script from that project's root, and a relative path the script reads or writes lands there instead.
Use for work no device step can do: seed a database, write a fixture file, call an API, clean up after a run. Record it where it belongs in the walkthrough — a setup script goes BEFORE the restart-app it prepares for, because that is where it runs at replay.
UNLIKE flow-add-step, a failure records NOTHING: the step is appended only when the script passes, because a failed script did not establish the state the rest of the recording would be walked against. Nothing the script did before it stopped is rolled back, and \`message\` says whether anything ran — clean up, or make the re-run safe, before calling again. A call that ends in a TRANSPORT error returns no \`message\` at all and may have run the script more than once.
\`outputJson\` is the document the script returned; no flow step can reference it yet.
Returns { message, status, stepCount, reason?, durationMs?, outputJson?, outputTruncated?, recorded?, savedTo? } — \`reason\` says what stopped a call that did not pass, \`outputTruncated\` says the 64 KiB render limit cut \`outputJson\`, which leaves a prefix that NO LONGER PARSES as JSON, and \`recorded\` and \`savedTo\` come back only on a pass.
Refused when the recording's project root is not on this tool server's filesystem: the .mjs stays on the client, so there is nothing here to run.`,
  // A script's default limit is 30s and its host cap five minutes, against the
  // MCP adapter's 30s per-request fetch budget. Without this the adapter aborts
  // a slow call and RETRIES it, re-running a script whose whole purpose is a
  // side effect. It also keeps the server's idle timer warm for the call's
  // duration, so auto-shutdown cannot reap the host mid-script.
  //
  // The flag only skips the adapter's own abort timer; its retry loop is
  // untouched, so a call that fails some other way is still re-POSTed.
  longRunning: true,
  zodSchema,
  services: () => ({}),
  async execute(_services, params, ctx) {
    const session = await requireRecordingSession(params.project_root, params.name);

    if (session.persist !== "host") {
      throw new FailureError(
        `Cannot record a script step for "${params.name}": this recording's project root is not ` +
          `on the tool server's filesystem, so ${session.filePath} — and the .mjs file beside it ` +
          `— exist only on your machine. There is nothing here to resolve "${params.path}" ` +
          `against and nothing to run. Record against a tool server that shares your filesystem, ` +
          `or finish the recording, add the \`script:\` step to the YAML by hand, and replay it ` +
          `locally.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_add_script_client_mode",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    // Validated by the flow parser's own helpers, against the entry they would
    // read out of YAML: a path this tool accepts is a path parseFlow accepts,
    // and a rejection reads the same as in a hand-written flow.
    const entry = {
      script: {
        path: params.path,
        ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
      },
    };
    const step: Extract<FlowStep, { kind: "script" }> = {
      kind: "script",
      path: parseScriptPath(entry, params.path),
      ...(params.timeout !== undefined
        ? { timeout: parseScriptTimeout(entry, params.timeout) }
        : {}),
    };

    const flowDir = nodePath.dirname(await canonicalFlowPath(session.filePath));

    // Run BEFORE taking the flow-file lock: a script may run for minutes, and
    // appendStepToFlow holds a per-key lock that would block every other call on
    // this recording for that whole duration.
    const { outcome, result, ran } = await runFlowScriptStep({
      flowDir,
      step,
      projectRoot: params.project_root,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });

    const common = {
      status: outcome.status,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(result ? { durationMs: result.durationMs } : {}),
    };

    if (outcome.status !== "pass") {
      const { lead, nextMove, leftBehind } = FAILED_CALL[ran];
      // The script ran outside the flow-file lock, so the recording this call
      // resolved up front may have been finished or restarted in that window —
      // the same race `appendStepToFlow` catches for a script that PASSED. This
      // exit writes nothing and so never reaches that guard, and both claims it
      // would otherwise make are then about a file another take owns: that the
      // flow is as it was, and the count read back off it. Say what is true
      // instead, and do not send the author back to a key that is no longer
      // theirs — the retry `nextMove` invites appends into the take that
      // replaced it. Split the two losses the way the guard does: a restart put
      // a live take on the key, a finish left it free with a finished flow on
      // disk, and only the first makes the file another take's.
      const state = recordingSessionState(session);
      if (state !== "live") {
        const lost =
          state === "restarted"
            ? `it was restarted while the script was running, so ${session.filePath} belongs to ` +
              `another take now and this call cannot say what is in it`
            : `it was finished (or dropped by the concurrent-recording cap) while the script was ` +
              `running, so ${session.filePath} holds that finished take`;
        return {
          ...common,
          message:
            `The script "${step.path}" ${lead}, and nothing was recorded — but recording ` +
            `"${params.name}" in ${params.project_root} is no longer active either: ${lost}. ` +
            `\`stepCount\` is this take's own last count, not a fresh read of the file. ` +
            `${leftBehind} Re-record under a fresh name rather than restarting this one — ` +
            `flow-start-recording truncates unconditionally, and on this key there is now ` +
            `something to lose.`,
          stepCount: session.flow.steps.length,
        };
      }
      const { stepCount, note } = await recordedStepCount(session);
      return {
        ...common,
        message:
          `The script "${step.path}" ${lead} — nothing was recorded in "${params.name}", so the ` +
          `flow is exactly as it was. ${nextMove}${note ? ` ${note}` : ""}`,
        stepCount,
      };
    }

    let savedTo: FlowSavedTo;
    let stepCount: number;
    try {
      ({ savedTo, stepCount } = await appendStepToFlow(session, step));
    } catch (err) {
      // A host-mode append re-parses the WHOLE file before it pushes, so the
      // scan that refuses an output reference judges the steps already in it as
      // well — and a mid-recording hand edit is a supported way for one of those
      // to carry one. A `script` step spells none of the fields that scan reads,
      // so a refusal on this path is never about the step just run: saying
      // "recording it failed" would send the author back over the one call that
      // did nothing wrong, and never name the edit that has to be undone.
      const refusedAnEarlierStep = getFailureSignal(err)?.failure_stage === "flow_output_reference";
      throw wrapFailure(
        err,
        {
          error_code: FAILURE_CODES.FLOW_FILE_WRITE_FAILED,
          failure_stage: "flow_add_script_append",
          failure_area: "tool_server",
          error_kind: "unknown",
        },
        `The script "${step.path}" ran and passed in ${result!.durationMs}ms and nothing it did ` +
          `was rolled back, but ` +
          (refusedAnEarlierStep
            ? `a step ALREADY in the flow file spells an output reference, so the append re-read ` +
              `it and refused. The step named below is that one, not this script — remove the ` +
              `reference from ${session.filePath} and the recording continues. This call's ` +
              `output document is lost with this error. `
            : `recording it failed — so the step is not in the flow, and its output document is ` +
              `lost with this error. `) +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }

    const rendered = result?.output ? renderOutput(result.output) : undefined;
    return {
      ...common,
      message:
        `Script step added to "${params.name}" flow — it ran here as a replay of this flow will; ` +
        `composed into a flow under another project root with \`run:\`, it runs from that root. ` +
        // A cut document is not merely short: it stops being JSON. Say so here
        // rather than leave `outputTruncated` to contradict a sentence that
        // otherwise reads as a whole-document guarantee.
        (rendered?.outputTruncated
          ? `\`outputJson\` is the first ${OUTPUT_RENDER_LIMIT_BYTES / 1024} KiB of what the ` +
            `script returned — the rest was cut, so it no longer parses as JSON; `
          : `\`outputJson\` is what the script returned; `) +
        `no flow step can reference it yet.`,
      ...(rendered ?? {}),
      stepCount,
      recorded: summarizeStep(step, stepCount),
      savedTo,
    };
  },
};
