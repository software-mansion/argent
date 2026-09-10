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
  assertNoEnvOutputReferences,
  countStepsOnDisk,
  flowEnvOnDisk,
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
import { canonicalFlowPath } from "./flow-file-refs";
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
  name: z.string().describe("Flow name passed to flow-start-recording."),
  project_root: z.string().describe("Absolute project root passed to flow-start-recording."),
  path: z
    .string()
    .describe(
      'Path to the .mjs or .sh file, relative to the flow YAML. For example: "../../scripts/seed-order.mjs". A .mjs runs under Node, a .sh under bash.'
    ),
  timeout: z
    .number()
    .optional()
    .describe("Optional time limit in milliseconds. The default is 30000 and the minimum is 100."),
  env: scriptEnvParameter("This call's")
    .optional()
    .describe(
      "Environment values this script reads from its environment (`process.env` in a `.mjs`, `$NAME` in a `.sh`), for this script only. Recorded verbatim as the step's `env`, and the flow file's own top-level `env` defaults are layered UNDER it here and at replay alike — so the run here matches a replay OF THIS FILE. A real replay merges two further layers, and only one of them goes under both: each parent flow's `env:` when a `run:` step composes this one is another default, below the file's own, while the run's own --env/flow-execute values sit BETWEEN the two layers here — above the file's `env:`, still under this map. So a file-level value this call took can be replaced at replay by --env; a value in this map cannot. Values are strings; quote a number. A name must match [A-Za-z_][A-Za-z0-9_]* and must not be NODE_OPTIONS, NODE_CHANNEL_FD, NODE_UNIQUE_ID, NODE_CHANNEL_SERIALIZATION_MODE, ELECTRON_RUN_AS_NODE, ARGENT_FLOW_SCRIPT_RUNNER, ARGENT_OUTPUT, or any npm spelling of npm_config_node-options / npm_config_userconfig / npm_config_globalconfig. Do not use __proto__ either: it is an accessor rather than an entry, so `z.record` would rebuild the map without it and the step would be recorded with the entry silently gone — this parameter refuses the name instead. " +
        "Put a credential behind `{{secret:<NAME>}}` rather than in the clear: this map is written into the flow file, so a plaintext value gets committed, and it also enters your context and ~/.argent/mcp-calls.log, which records every call whole. The placeholder is resolved on the machine running the tool-server, from `ARGENT_SECRET_<NAME>`, the project's `.argent/secrets.env`, the `ARGENT_SECRET_` keys of its `.env.local`/`.env`, then `~/.argent/secrets.env`. " +
        "A shell `export` does NOT reach a script: the tool server's environment is a snapshot from its first start, so a value exported after it started is not in that snapshot at all. `scripts.env.allow` only widens which NAMES are copied out of it, so it cannot recover one — pass the value here, or restart the tool server."
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

/**
 * Whether two environments are the same map, as the CHILD would see them.
 *
 * Keyed through {@link envNameKey}, because that is what the merge above these
 * two maps folds by: on Windows a case-only rename is one variable with one
 * value to the script, and comparing the raw names reported drift the script
 * never saw — then told the author to delete the step and run a side-effecting
 * script again.
 */
function sameEnv(before: ScriptEnv | undefined, after: ScriptEnv | undefined): boolean {
  const a = before ?? {};
  const b = after ?? {};
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;
  const byKey = new Map(Object.entries(b).map(([name, value]) => [envNameKey(name), value]));
  return names.every((name) => byKey.get(envNameKey(name)) === a[name]);
}

/** The flow-level names in force, for a message that reports a change. */
function envNames(env: ScriptEnv | undefined): string {
  const names = Object.keys(env ?? {});
  return names.length > 0 ? `env ${names.join(", ")}` : "no flow-level env";
}

/**
 * What changed, in names.
 *
 * {@link sameEnv} compares VALUES and {@link envNames} renders NAMES, so an
 * edit that only changed a value would otherwise print the same text on both
 * sides of the sentence — a difference the message announces and then does not
 * show. That case says so in words instead; the file at `savedTo` holds both.
 */
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
  description: `Run a local .mjs or .sh file and record it as a \`script:\` step in an active flow. Use this tool only when the user requests a local script in the flow. Pass the same \`name\` and \`project_root\` as \`flow-start-recording\`, and call it where the script must run. It runs the file the way a replay OF THIS FILE will: this call's \`env\` over the flow file's own top-level \`env:\`. A real replay merges two more layers — the run's own --env/flow-execute values, which sit BETWEEN those two, and each parent flow's \`env:\` when a \`run:\` step composes this one, which goes under both. A failed script is not recorded. Check \`reason\` and the affected state before you retry.`,
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
        `Cannot access the script for flow "${params.name}". Finish the recording, add the ` +
          `\`script:\` step to the YAML, and replay it locally.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_add_script_client_mode",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    // The `env` ARGUMENT is judged before the entry is built, for the reason
    // flow-execute judges its own: this is a caller's parameter, so it earns a
    // caller's refusal — named after the parameter and answered 400 — rather
    // than the flow parser's "Unrecognized flow entry", which is worded for a
    // step already written into a file. The parser's own helper below then has
    // nothing left to reject on this path; it still guards the shape the entry
    // is built into.
    const envProblem = describeScriptEnvProblem(params.env ?? {});
    if (envProblem) {
      // Named after the channel, like the sibling refusal in `flow-run.ts` and
      // like the two `assertNoEnvOutputReferences` raises: this recording's
      // file can carry a top-level `env:` of its own, and a bare `env` does not
      // say which of the two the author must edit.
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

    // Before the script runs, not after. The append re-parses the whole file
    // and would refuse this map there — but by then the script has run for real
    // and nothing it did is rolled back, and that refusal is written for a step
    // ALREADY in the file, so it would send the caller to edit a flow that does
    // not hold this step yet. Re-raised as caller input, like the name rule
    // above it: this is the same argument that rule judges.
    try {
      assertNoEnvOutputReferences(step.env, "This call's");
    } catch (err) {
      throw new InvalidToolInputError(err instanceof Error ? err.message : String(err), {
        failure_stage: "flow_add_script_env",
      });
    }

    // The recording's own flow-level `env` goes UNDER the step's map, exactly as
    // the runner will layer it at replay. Read off the FILE, because that is
    // where a top-level `env:` the agent hand-added lives before the first
    // append catches the in-memory copy up — and without this the live run and
    // the replay would take different environments, which is the one failure a
    // recorded script step exists to prevent.
    //
    // A file that will not read or parse STOPS the call rather than falling back
    // to the in-memory copy. That copy is a different environment — in practice
    // an empty one, since a hand-added `env:` has never been through an append —
    // so the script would run without the map, silently. The append after the
    // run would refuse the same file anyway, by which time the script has run
    // and nothing is rolled back.
    let flowEnv: ScriptEnv | undefined;
    try {
      flowEnv = await flowEnvOnDisk(session);
    } catch (err) {
      // Three states, three different things to do. A file that is GONE cannot
      // be repaired and this tool cannot re-create it — only
      // flow-start-recording establishes the key. A file that could not be READ
      // is a permission or a device problem, and "it may not parse, or it may
      // parse and break a rule" sends the author to look for a fault in content
      // argent never saw. Only the third is a flow to repair. The read failure
      // is what carries an errno; a parse refusal is a FailureError and carries
      // none.
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
              `recording again with flow-start-recording and re-walk it. `
            : unreadable
              ? `${session.filePath} could not be read. Nothing is wrong with the flow itself, ` +
                `as far as argent got: the append after the run reads the same file and would ` +
                `fail the same way, with the script already run and nothing rolled back — and ` +
                `the flow-level \`env\` this run has to share with the replay is read off it ` +
                `too. Make the file readable and call this again. `
              : `${session.filePath} is not a flow argent can use as it stands — it may not ` +
                `parse, or it may parse and break a rule. The append after the run re-reads ` +
                `that file and would refuse it then, with the script already run and nothing ` +
                `rolled back — and the flow-level \`env\` this run has to share with the replay ` +
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
            `Use a new flow name because flow-start-recording overwrites the existing file. ` +
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
      // A host-mode append re-parses the WHOLE file before it pushes, so the
      // scan that refuses an output reference judges what is already in the file
      // as well — a step from an earlier call, or the file's own top-level
      // `env:`, both of which a mid-recording hand edit can put there. The step
      // just run is not among them: its own `env` is refused before the script
      // starts, and a `script` step spells no other field that scan reads.
      // Saying "recording it failed" would send the author back over the one
      // call that did nothing wrong, and never name the edit to undo.
      //
      // Three stages, not one, and each is read off the file BEFORE this step
      // joins it. The output reference is one; every other `env:` fault a hand
      // edit can leave — a reserved name, a non-string value, a tagged map, a
      // name that is not one — arrives as `flow_file_parse` or
      // `flow_file_parse_step`. The two sibling recorders answer all three; this
      // is the recorder where the wording costs most, because the script has
      // already run and nothing it did is rolled back, so "check the script's
      // changes before you retry" sends the author over a script that did
      // exactly what it was asked.
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

    // The file's `env:` was read before a run that may have taken minutes, and
    // the append re-read it afterwards. An edit landing in that window is
    // recorded and replays under an environment this run never took, so the
    // promise the message makes has to be withdrawn when it no longer holds.
    //
    // Compared as the STEP will see them, not as the file spells them: the
    // step's own map sits over both, so an edit to a name it already overrides
    // changes nothing the script reads. Comparing the flow-level maps alone
    // withdrew the promise for an environment that had not moved, and told the
    // author to delete the step and run a side-effecting script again.
    const envDrifted = !sameEnv(
      mergeScriptEnv(flowEnv, step.env),
      mergeScriptEnv(appendedEnv, step.env)
    );
    const rendered = result?.output ? renderOutput(result.output) : undefined;
    return {
      ...common,
      // The plain form is the one the tool already answered with, unchanged:
      // what a caller reads on a normal call is "the step is in the flow", and
      // the layering `env` adds is the parameter's own documentation, not news
      // to repeat on every success.
      message: envDrifted
        ? `Added script step to "${params.name}" flow, but the flow file's own \`env\` changed ` +
          `while the script was running: ${describeEnvDrift(flowEnv, appendedEnv)}. The step IS ` +
          `in the file — calling this again would append a SECOND one and run the script's ` +
          `side effect twice. Remove it first if you want it recorded under the environment ` +
          `now on disk.`
        : `Added script step to "${params.name}" flow.`,
      ...(rendered ?? {}),
      stepCount,
      recorded: summarizeStep(step, stepCount),
      savedTo,
    };
  },
};
