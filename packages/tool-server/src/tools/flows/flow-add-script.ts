import { z } from "zod";
import * as nodePath from "node:path";
import {
  canonicalFlowPath,
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  wrapFailure,
  type ToolDefinition,
} from "@argent/registry";
import {
  appendStepToFlow,
  assertNoEnvOutputReferences,
  countStepsOnDisk,
  flowEnvOnDisk,
  isLinkedRecorderCall,
  parseScriptEnv,
  parseScriptPath,
  parseScriptTimeout,
  recordingSessionState,
  requireRecordingSession,
  type FlowSavedTo,
  type FlowStep,
  type RecordingSession,
  type ScriptEnv,
} from "./flow-utils";
import { runFlowScriptStep, type ScriptRan } from "./flow-script-step";
import { utf8SafeCut } from "./script/flow-script-executor";
import { summarizeStep } from "./flow-step-definitions";
import {
  envNameKey,
  describeScriptEnvProblem,
  mergeScriptEnv,
  scriptEnvParameter,
} from "./script/flow-script-env";
import { InvalidToolInputError } from "../../utils/capability";

const OUTPUT_RENDER_LIMIT_BYTES = 64 * 1024;

const zodSchema = z.object({
  name: z.string().describe("E2E test name passed to e2e-start-recording."),
  project_root: z.string().describe("Absolute project root passed to e2e-start-recording."),
  path: z
    .string()
    .describe(
      'Path to the .mjs (Node.js) or .sh (Bash) file, relative to the e2e test YAML. For example: "../../scripts/seed-order.mjs".'
    ),
  timeout: z
    .number()
    .optional()
    .describe("Optional time limit in milliseconds. The default is 30000 and the minimum is 100."),
  env: scriptEnvParameter("This call's")
    .optional()
    .describe(
      "Environment variables for this script. Use string values and names that match [A-Za-z_][A-Za-z0-9_]*. " +
        "Argent saves this map as the step's `env`. These values replace the e2e test's defaults and take priority over `--env` at replay. " +
        "For values that change per run, use the e2e test's top-level `env` instead. " +
        "Use `{{secret:NAME}}` for credentials; plaintext values remain visible in the e2e test file and tool logs."
    ),
});

interface FlowAddScriptResult {
  message: string;
  status: "pass" | "fail" | "error";
  reason?: string;
  log?: string;
  logTruncated?: true;
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
    note: `Could not verify stepCount from ${session.filePath}.`,
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
    nextMove: "Check or restore its changes before you retry.",
    leftBehind: "Check or restore its changes.",
  },
  no: {
    lead: "did not run",
    nextMove: "Fix the reason before you retry.",
    leftBehind: "Nothing ran.",
  },
  unknown: {
    lead: "may have run",
    nextMove: "Check its changes before you retry.",
    leftBehind: "Check its changes.",
  },
};

function sameEnv(before: ScriptEnv | undefined, after: ScriptEnv | undefined): boolean {
  const a = before ?? {};
  const b = after ?? {};
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;
  const byKey = new Map(Object.entries(b).map(([name, value]) => [envNameKey(name), value]));
  return names.every((name) => byKey.get(envNameKey(name)) === a[name]);
}

function envNames(env: ScriptEnv | undefined): string {
  const names = Object.keys(env ?? {});
  return names.length > 0 ? `env ${names.join(", ")}` : "no top-level env";
}

function describeEnvDrift(before: ScriptEnv | undefined, after: ScriptEnv | undefined): string {
  const names = Object.keys(before ?? {});
  const sameNames =
    names.length === Object.keys(after ?? {}).length &&
    names.every((name) => Object.hasOwn(after ?? {}, name));
  return sameNames
    ? `it ran with ${envNames(before)} and the recorded step will replay with those same names, ` +
        "at least one of them carrying a different value"
    : `it ran with ${envNames(before)} and the recorded step will replay with ${envNames(after)}`;
}

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
  id: "e2e-add-script",
  aliases: ["flow-add-script"],
  interaction: {
    startedMsg: ({ params }) => `Running script for e2e test ${params.name}`,
    completedMsg: ({ params, result }) =>
      result.status === "pass"
        ? `Added script step to e2e test ${params.name}`
        : `Script for e2e test ${params.name} failed; nothing recorded`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to add script step to e2e test ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Run a local .mjs or .sh file and record it as a \`script:\` step in an active e2e test. Use when the user requests a local script in the e2e test, and only then. Pass the same \`name\` and \`project_root\` as \`e2e-start-recording\`, and call it where the script must run. Returns \`status\`, \`reason\` and \`stepCount\`. A failed script is not recorded. Check \`reason\` and the affected state before you retry. Over a link (argent link or ARGENT_TOOLS_URL), the tool refuses the call: record such an e2e test with no link.`,
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

    // A replay over a link refuses every `script:` step, so a recording over
    // one must not run or record one either.
    if (isLinkedRecorderCall(session, ctx)) {
      throw new FailureError(
        `Cannot add a script step to e2e test "${params.name}": the recording is over a link ` +
          `(argent link or ARGENT_TOOLS_URL), and an e2e test cannot run script steps over a link. ` +
          `Nothing ran and no step was recorded. To record a script step, record the e2e test on ` +
          `the computer that runs the tool-server, with no link and no ARGENT_TOOLS_URL.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_add_script_client_mode",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const envProblem = describeScriptEnvProblem(params.env ?? {});
    if (envProblem) {
      throw new InvalidToolInputError(`This call's \`env\` ${envProblem}`, {
        failure_stage: "flow_add_script_env",
      });
    }

    // Validated by the flow parser's own helpers, against the entry they would
    // read out of YAML: a path this tool accepts is a path parseFlow accepts,
    // and a rejection reads the same as in a hand-written flow.
    const entry = {
      script: {
        path: params.path,
        ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
        ...(params.env !== undefined ? { env: params.env } : {}),
      },
    };
    const step: Extract<FlowStep, { kind: "script" }> = {
      kind: "script",
      path: parseScriptPath(entry, params.path),
      ...(params.timeout !== undefined
        ? { timeout: parseScriptTimeout(entry, params.timeout) }
        : {}),
      ...(params.env !== undefined ? { env: parseScriptEnv(entry, params.env) } : {}),
    };

    try {
      assertNoEnvOutputReferences(step.env, "This call's");
    } catch (err) {
      throw new InvalidToolInputError(err instanceof Error ? err.message : String(err), {
        failure_stage: "flow_add_script_env",
      });
    }

    let flowEnv: ScriptEnv | undefined;
    try {
      flowEnv = await flowEnvOnDisk(session);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      const missing = errno === "ENOENT";
      const unreadable = typeof errno === "string" && !missing;
      throw wrapFailure(
        err,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_add_script_env",
          failure_area: "tool_server",
          error_kind: "validation",
        },
        `The script "${step.path}" was NOT run and nothing was recorded in "${params.name}": ` +
          (missing
            ? `${session.filePath} is gone. Everything recorded into it is gone with it, and ` +
              `the append after the run reads that file before it writes one, so it would fail ` +
              `on the same missing path and the script would have run for nothing. Start the ` +
              `recording again with e2e-start-recording and re-walk it. `
            : unreadable
              ? `${session.filePath} could not be read. Nothing is wrong with the e2e test itself, ` +
                `as far as argent got: the append after the run reads the same file and would ` +
                `fail the same way, with the script already run and nothing rolled back — and ` +
                `the top-level \`env\` this run has to share with the replay is read off it ` +
                `too. Make the file readable and call this again. `
              : `${session.filePath} is not an e2e test argent can use as it stands — it may not ` +
                `parse, or it may parse and break a rule. The append after the run re-reads ` +
                `that file and would refuse it then, with the script already run and nothing ` +
                `rolled back — and the top-level \`env\` this run has to share with the replay ` +
                `is read off it too, so running now would give the script an environment the ` +
                `recorded step will not take. The reason below is about the FILE, not about ` +
                `this script. Repair it and call this again. `) +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }

    const flowDir = nodePath.dirname(await canonicalFlowPath(session.filePath));

    // Run BEFORE taking the flow-file lock: a script may run for minutes, and
    // appendStepToFlow holds a per-key lock that would block every other call on
    // this recording for that whole duration.
    //
    // No `logBudget`: the run-scoped allowance would silently truncate a late
    // script's logs during authoring. The per-step limit still applies.
    const { outcome, result, ran } = await runFlowScriptStep({
      flowDir,
      step,
      projectRoot: params.project_root,
      env: mergeScriptEnv(flowEnv, step.env),
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });

    const common = {
      status: outcome.status,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.scriptLog !== undefined ? { log: outcome.scriptLog } : {}),
      ...(outcome.scriptLogTruncated ? { logTruncated: true as const } : {}),
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
            ? `Recording "${params.name}" was replaced.`
            : `Recording "${params.name}" ended.`;
        return {
          ...common,
          message:
            `Script "${step.path}" ${lead}; no step was recorded. ${lost} ${leftBehind} ` +
            `Use a new e2e test name because e2e-start-recording overwrites the existing file. ` +
            `stepCount is from the ended recording.`,
          stepCount: session.flow.steps.length,
        };
      }
      const { stepCount, note } = await recordedStepCount(session);
      return {
        ...common,
        message:
          `Script "${step.path}" ${lead}; no step was recorded. ${nextMove}` +
          (note ? ` ${note}` : ""),
        stepCount,
      };
    }

    let savedTo: FlowSavedTo;
    let stepCount: number;
    let appendedEnv: ScriptEnv | undefined;
    try {
      ({ savedTo, stepCount, flowEnv: appendedEnv } = await appendStepToFlow(session, step));
    } catch (err) {
      // A host-mode append re-parses the WHOLE file before it pushes, so a
      // refusal from that parse or from the output-reference scan judges what is
      // already in the file — and a mid-recording hand edit is a supported way to
      // put something there. Saying "recording it failed" would send the author
      // back over the one call that did nothing wrong, and never name the edit
      // that has to be undone.
      const stage = getFailureSignal(err)?.failure_stage;
      const refusedTheFile =
        stage === "flow_output_reference" ||
        stage === "flow_file_parse" ||
        stage === "flow_file_parse_step";
      throw wrapFailure(
        err,
        {
          error_code: FAILURE_CODES.FLOW_FILE_WRITE_FAILED,
          failure_stage: "flow_add_script_append",
          failure_area: "tool_server",
          error_kind: "unknown",
        },
        `Script "${step.path}" passed, but the step was not recorded. ` +
          (refusedTheFile
            ? `Fix what is named below in ${session.filePath} — it is already in the file, ` +
              `not in this script. `
            : "Check the script's changes before you retry. ") +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }

    const envDrifted = !sameEnv(
      mergeScriptEnv(flowEnv, step.env),
      mergeScriptEnv(appendedEnv, step.env)
    );
    const rendered = result?.output ? renderOutput(result.output) : undefined;
    return {
      ...common,
      message: envDrifted
        ? `Added script step to "${params.name}" e2e test, but the e2e test file's own \`env\` changed ` +
          `while the script was running: ${describeEnvDrift(flowEnv, appendedEnv)}. The step IS ` +
          `in the file — calling this again would append a SECOND one and run the script's ` +
          `side effect twice. Remove it first if you want it recorded under the environment ` +
          `now on disk.`
        : `Added script step to "${params.name}" e2e test.`,
      ...(rendered ?? {}),
      stepCount,
      recorded: summarizeStep(step, stepCount),
      savedTo,
    };
  },
};
