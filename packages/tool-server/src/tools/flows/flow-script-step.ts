import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_FILE_NAME_PATTERN } from "@argent/registry";
import type { FlowStep } from "./flow-utils";
import { canonicalFlowPath, resolveFlowRelativeFile } from "./flow-file-refs";
import {
  flowScriptExecutor,
  type FlowScriptFailureKind,
  type FlowScriptLogBudget,
  type FlowScriptResult,
} from "./script/flow-script-executor";

/**
 * One `script` step, from a path to a verdict.
 *
 * The flow runner and `flow-add-script` both come through here: a recorded step
 * that ran differently from the way it will replay would make the recording
 * prove nothing, so there is one path and each caller supplies only its own
 * anchor and its own run-scoped extras.
 */

interface FlowScriptStepOutcome {
  status: "pass" | "fail" | "error";
  reason?: string;
  scriptLog?: string;
  scriptLogTruncated?: true;
}

interface FlowScriptStepRun {
  outcome: FlowScriptStepOutcome;
  result?: FlowScriptResult;
  ran: ScriptRan;
}

interface FlowScriptStepRequest {
  /**
   * Directory of the flow file that NAMES the step — the resolution anchor.
   * Canonical (symlink-resolved), because the runner's is.
   */
  flowDir: string;
  step: Extract<FlowStep, { kind: "script" }>;
  projectRoot: string;
  logBudget?: FlowScriptLogBudget;
  signal?: AbortSignal;
}

export async function runFlowScriptStep(
  request: FlowScriptStepRequest
): Promise<FlowScriptStepRun> {
  const { flowDir, step } = request;
  const target = step.path;
  const { canonical, spelling } = await resolveFlowRelativeFile(
    flowDir,
    target,
    SCRIPT_FILE_NAME_PATTERN
  );
  const suppliedBase = path.posix.basename(target);

  // macOS (APFS) and Windows (NTFS) compare file names without case, so
  // `path: scripts/CreateUser.mjs` opens a file really named `createUser.mjs`:
  // the flow passes here every time it is repeated, then fails with ENOENT on
  // Linux CI with nothing in the flow file to show why. Only `case_folded`
  // refuses — a basename matching nothing at all is an ordinary missing file,
  // reported below, and an unreadable listing vouches for nothing.
  if (spelling.state === "case_folded") {
    const recovery = spelling.addressable
      ? `write it as "${target.slice(0, target.length - suppliedBase.length)}${spelling.actual}"`
      : `rename "${spelling.actual}" to "${suppliedBase}" to run it — a script filename must ` +
        `match ${SCRIPT_FILE_NAME_PATTERN}`;
    return {
      ran: "no",
      outcome: {
        status: "error",
        reason:
          `mis-cased script path "${target}": the directory holds "${spelling.actual}", not ` +
          `"${suppliedBase}" — a case-sensitive checkout (Linux CI) fails this step with ` +
          `ENOENT — ${recovery}`,
      },
    };
  }

  const missing = await scriptFileProblem(canonical);
  if (missing) {
    return {
      ran: "no",
      outcome: {
        status: "fail",
        reason: `script "${target}" ${missing} (resolved to ${canonical})`,
      },
    };
  }

  const result = await flowScriptExecutor().execute({
    scriptPath: canonical,
    output: {},
    ...(step.timeout !== undefined ? { timeoutMs: step.timeout } : {}),
    projectRoot: request.projectRoot,
    flowDir,
    // No `secrets`: nothing resolves one into a script step yet, so there is
    // nothing for the executor to redact out of the captured log.
    ...(request.logBudget ? { logBudget: request.logBudget } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  const verdict = scriptVerdict(result);
  const frames = result.ok
    ? ""
    : scriptFrames(result.failure?.stack, [
        request.projectRoot,
        await canonicalFlowPath(request.projectRoot),
      ]);
  return {
    outcome: {
      ...verdict,
      ...(frames && verdict.reason !== undefined ? { reason: verdict.reason + frames } : {}),
      ...(result.log ? { scriptLog: result.log } : {}),
      ...(result.logTruncated ? { scriptLogTruncated: true } : {}),
    },
    result,
    ran: scriptRan(result),
  };
}

/**
 * How many of the script's own frames ride into the reason. A thrown message
 * alone names no file and no line, and a throw writes nothing to stderr, so
 * without these the step's whole diagnostic is one sentence and there is
 * nothing in CI to re-run against. Six is what a rethrow needs to show where it
 * came from without turning the step line into the whole stack; the executor's
 * `SCRIPT_MAX_FAILURE_STACK_CHARS` still holds what it captured.
 */
const SCRIPT_REASON_MAX_FRAMES = 6;

/** A frame in the host's own machinery, not in anything the author wrote. */
function isHostFrame(frame: string): boolean {
  return (
    frame.includes("node:internal") ||
    frame.includes("flow-script-runner.mjs") ||
    frame.includes("flow-script-watchdog")
  );
}

/**
 * `file:///abs/path/seed.mjs:1:30` reads as `scripts/seed.mjs:1:30`. The frames
 * go on ONE step line, so the anchor is the run's own `project_root` — the
 * directory the script also ran in. A script outside it keeps its absolute
 * path, because a `..` chain says less than the path does.
 *
 * `roots` is that directory both as given and canonicalized, because only one
 * of the two ever matches: Node resolves a module to its REAL path, so every
 * frame is canonical, while `project_root` arrives as the caller spelled it. On
 * macOS a project under `/var` (or any symlinked parent) is the ordinary case
 * of the two differing.
 */
function readableFrame(frame: string, roots: readonly string[]): string {
  return frame.replace(/file:\/\/[^\s)]+/g, (match) => {
    const split = /^(.*?)(:\d+:\d+)$/.exec(match);
    const url = split ? split[1]! : match;
    const position = split ? split[2]! : "";
    let file: string;
    try {
      file = fileURLToPath(url);
    } catch {
      return match;
    }
    for (const root of roots) {
      const relative = path.relative(root, file);
      if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return `${relative}${position}`;
      }
    }
    return `${file}${position}`;
  });
}

/**
 * The frames of a failed script, as a block appended to its message. Newline
 * separated on purpose: `oneLineReason` escapes them, so the block reads as
 * `\n    at …` on the step's own line and a reader can still tell one frame
 * from the next. The stack's first line is dropped — it only repeats the
 * message the reason already opens with.
 */
function scriptFrames(stack: string | undefined, roots: readonly string[]): string {
  if (!stack) return "";
  const frames: string[] = [];
  let dropped = 0;
  for (const line of stack.split("\n")) {
    const frame = line.trim();
    if (!frame.startsWith("at ") || isHostFrame(frame)) continue;
    if (frames.length >= SCRIPT_REASON_MAX_FRAMES) {
      dropped++;
      continue;
    }
    frames.push(`    ${readableFrame(frame, roots)}`);
  }
  if (frames.length === 0) return "";
  if (dropped > 0) frames.push(`    … ${dropped} more frame${dropped === 1 ? "" : "s"}`);
  return `\n${frames.join("\n")}`;
}

export type ScriptRan = "yes" | "no" | "unknown";

const NEVER_FORKED: ReadonlySet<FlowScriptFailureKind> = new Set(["invalid", "spawn", "queue"]);

/**
 * Whether the author's script left anything behind — the question "is there
 * something to clean up" turns on, and one a result's mere presence does not
 * answer: the executor returns a full result for a queue it could not admit the
 * step to and for a spawn that never happened.
 *
 * Read the executor's own `beforeFork` first, because it is the only signal
 * that separates the two halves of `cancelled`. That kind lands either side of
 * the fork: a signal already aborted when the call arrived, or one raised while
 * the step waited for a slot, never reached a child — while a cancellation that
 * stopped a running process left whatever it had already done. The kinds below
 * answer from the kind alone; this one cannot, and "nothing to clean up" is the
 * answer that has to be proved rather than balanced on which half is likelier.
 *
 * `protocol` is the one kind that cannot be answered either way, so it does not
 * pretend to. It is the runner failing AROUND the script, and every protocol
 * failure the executor raises itself lands before Node evaluates the entry — a
 * malformed request the runner parked on, a channel that closed before the
 * request arrived, a runner that exited without ever saying it started — so
 * usually nothing ran. But the runner's `process.send` is not the only way onto
 * that channel: a script that writes a line to the channel descriptor reaches
 * the same kind having already done its work, and "nothing ran" is the more
 * dangerous of the two to claim wrongly.
 *
 * Everything else answers yes: the script was forked, so it had the chance.
 */
function scriptRan(result: FlowScriptResult): ScriptRan {
  if (result.ok || !result.failure) return "yes";
  const { kind, beforeFork } = result.failure;
  if (beforeFork || NEVER_FORKED.has(kind)) return "no";
  return kind === "protocol" ? "unknown" : "yes";
}

async function scriptFileProblem(canonical: string): Promise<string | null> {
  try {
    const stat = await fs.stat(canonical);
    return stat.isFile() ? null : "is not a file";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? "does not exist"
      : `cannot be read: ${errMsg(err)}`;
  }
}

/**
 * The line between `fail` and `error` is who is at fault. A `fail` is the
 * SCRIPT's answer: it threw, it never loaded, it returned something that cannot
 * cross into flow state, or it stopped its own process. An `error` is
 * everything the runner did to it — a process it could not start, a limit it
 * hit, a signal it did not choose, a queue it never left. That split is what
 * lets CI read a red script step: a `fail` is a regression in the flow or the
 * system it talks to, an `error` is the machine it ran on.
 *
 * `cancelled` is an `error`, not a `skip`: every reader of a report takes
 * `skip` to mean the step did not run (the CLI's not-executed line,
 * `FlowRunResult.skipped`), and a script killed after reaching the system it
 * talks to left that state behind. A cancellation also lands on the near side
 * of the fork — a signal already aborted when the call arrived, or one raised
 * while the step waited for a concurrency slot — and the status does not try to
 * separate the two: `beforeFork` does, and {@link scriptRan} is what reads it.
 * What a runner marks `skip` is the step it never dispatched, at its own
 * pre-step abort gate; `flow-add-script` has no such gate and hands its
 * request's signal straight in, so an abort that arrived before the call does
 * reach here.
 *
 * Notes ride into the reason on every outcome, pass included. They are how the
 * executor says a time limit was clamped to the host's maximum, or that the
 * working directory it was given did not exist — and dropping them on a pass is
 * how a script that silently ran somewhere else stays silent.
 *
 * Exported for the test that pins the recorder's verdict and the runner's
 * against it, kind for kind.
 */
export function scriptVerdict(
  result: FlowScriptResult
): Pick<FlowScriptStepOutcome, "status" | "reason"> {
  const notes = result.notes.join(" ");
  if (result.ok) return { status: "pass", ...(notes ? { reason: notes } : {}) };
  const failure = result.failure;
  const message = failure?.message ?? "The script produced no verdict.";
  return {
    status: failure ? scriptFailureStatus(failure.kind) : "error",
    reason: notes ? `${message} ${notes}` : message,
  };
}

function scriptFailureStatus(kind: FlowScriptFailureKind): "fail" | "error" {
  switch (kind) {
    case "load":
    case "runtime":
    case "output":
    case "exit":
      return "fail";
    case "protocol":
    case "timeout":
    case "cancelled":
    case "signal":
    case "heap":
    case "spawn":
    case "queue":
    case "invalid":
      return "error";
    default: {
      const unclassified: never = kind;
      void unclassified;
      return "error";
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
