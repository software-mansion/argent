import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_FILE_NAME_PATTERN } from "@argent/registry";
import { hasScriptExtension, scriptInterpreter, type FlowStep, type ScriptEnv } from "./flow-utils";
import { canonicalFlowPath, resolveFlowRelativeFile } from "./flow-file-refs";
import {
  flowScriptExecutor,
  scrubScriptText,
  type FlowScriptFailureKind,
  type FlowScriptLogBudget,
  type FlowScriptResult,
  type FlowScriptRunNotes,
  type FlowScriptSecret,
} from "./script/flow-script-executor";
import { resolveScriptEnvSecrets } from "./script/flow-script-env";

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
  env?: ScriptEnv;
  runNotes?: FlowScriptRunNotes;
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
      ? `Use "${target.slice(0, target.length - suppliedBase.length)}${spelling.actual}".`
      : `Rename "${spelling.actual}" to "${suppliedBase}".`;
    return {
      ran: "no",
      outcome: {
        status: "error",
        reason: `Script path "${target}" has the wrong letter case. ${recovery}`,
      },
    };
  }

  const missing = await scriptFileProblem(canonical);
  if (missing) {
    return {
      ran: "no",
      outcome: {
        status: "fail",
        reason: `Script "${target}" ${missing}. Resolved path: ${canonical}.`,
      },
    };
  }

  let env: ScriptEnv;
  let secrets: FlowScriptSecret[];
  try {
    ({ env, secrets } = resolveScriptEnvSecrets(request.env ?? {}, { cwd: request.projectRoot }));
  } catch (err) {
    return { ran: "no", outcome: { status: "error", reason: errMsg(err) } };
  }

  const result = await flowScriptExecutor().execute({
    scriptPath: canonical,
    interpreter: scriptInterpreter(hasScriptExtension(canonical) ? canonical : target),
    output: {},
    ...(step.timeout !== undefined ? { timeoutMs: step.timeout } : {}),
    projectRoot: request.projectRoot,
    flowDir,
    ...(request.logBudget ? { logBudget: request.logBudget } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(request.runNotes ? { runNotes: request.runNotes } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  const shellLimit = describeShellEnvironmentLimit(result, env);
  const verdict = scriptVerdict(
    shellLimit ? { ...result, notes: [...result.notes, shellLimit] } : result
  );
  const frames = result.ok
    ? ""
    : scriptFrames(
        result.failure?.stack,
        [request.projectRoot, await canonicalFlowPath(request.projectRoot)],
        secrets
      );
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

const SCRIPT_REASON_MAX_FRAMES = 6;

function isHostFrame(frame: string): boolean {
  return (
    frame.includes("node:internal") ||
    frame.includes("flow-script-runner.mjs") ||
    frame.includes("flow-script-watchdog")
  );
}

const FRAME_FILE_URL_RE = /file:\/\/\S*?:\d+:\d+(?=[\s)]|$)|file:\/\/[^\s)]+/g;

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
  return frame.replace(FRAME_FILE_URL_RE, (match) => {
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

function scriptFrames(
  stack: string | undefined,
  roots: readonly string[],
  secrets: readonly FlowScriptSecret[]
): string {
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
  return scrubScriptText(`\n${frames.join("\n")}`, secrets);
}

const COMMAND_NOT_FOUND_SIGNATURES: readonly RegExp[] = [
  /^(?:[A-Za-z]:)?(?:[^\n:]*[/\\])?(?:[^\n:/\\]*\.)?(?:ba|da|k|z|a)?sh: (?:line )?(?:\d+: )?[^\n:]+: command not found[ \t\r]*$(?![\s\S]*\S)/im,
  /^(?:[A-Za-z]:)?(?:[^\n:]*[/\\])?(?:[^\n:/\\]*\.)?(?:ba|da|k|z|a)?sh: (?:line )?\d+: [^\n:]+: ?not found[ \t\r]*$(?![\s\S]*\S)/im,
  /^(?:[A-Za-z]:)?(?:[^\n:]*[/\\])?(?:[^\n:/\\]*\.)?(?:ba|da|k|z|a)?sh:(?:\d+:)? command not found: [^\s:]+[ \t\r]*$(?![\s\S]*\S)/im,
  /^'[^\n']+' is not recognized as an internal or external command,\r?\noperable program or batch file\.[ \t\r]*$(?![\s\S]*\S)/im,
];

const SPAWN_ENOENT = /spawn(?:Sync)? (?:[A-Za-z]:)?(?:[/\\~.][^\n:;,]*|[^\s:;,]+) ENOENT/;

const BASH_EXIT_127 =
  /^The script exited with code 127 \(bash: [^\n]*CRLF line endings\.[ \t\r]*([\s\S]*)$/m;

function saysCommandNotFound(text: string): boolean {
  return COMMAND_NOT_FOUND_SIGNATURES.some((signature) => signature.test(text));
}

function describeShellEnvironmentLimit(result: FlowScriptResult, env: ScriptEnv): string | null {
  if (result.ok) return null;
  const text = result.failure?.message ?? "";
  const bash127 = BASH_EXIT_127.exec(text);
  const wrote = bash127?.[1].trim();
  if (wrote !== undefined && wrote !== "" && !saysCommandNotFound(wrote)) return null;
  const what =
    bash127 !== null
      ? ""
      : saysCommandNotFound(text)
        ? "A command was not found. "
        : SPAWN_ENOENT.test(text)
          ? "A command was not found — or the working directory it was given does not exist, " +
            "which Node reports the same way. "
          : null;
  if (what === null) return null;
  const relayed = bash127 !== null ? saysCommandNotFound(wrote ?? "") : saysCommandNotFound(text);
  const whose = relayed
    ? " A shell reached through `adb shell` or `ssh` reports a command missing on the OTHER " +
      "end in these same words; nothing here changes that one."
    : "";
  const ownPath = pathEnvName(env);
  if (ownPath !== undefined) {
    // The NAME, never the value. This map is the RESOLVED one, so a
    // `{{secret:NAME}}` has already become its credential here — and a note is
    // not failure text: `redactSecrets` scrubs `failure.message` and
    // `failure.stack` and nothing else, so a value quoted into a note would
    // reach the step reason, the JSON report and ~/.argent/mcp-calls.log in the
    // clear, through the one message the redaction exists for. The author has
    // the value in front of them; what they do not have is the fact that it,
    // rather than the tool server, is what the command was looked up in.
    return (
      `${what}This run sets \`${ownPath}\` itself, through an \`env\` value, and that value — ` +
      "not the tool server's environment — is the whole search path the command was looked up " +
      `in. Widen it, or pass an absolute path.${whose}`
    );
  }
  return (
    `${what}The tool server keeps the environment it started with, so an ` +
    "`export` made later never reaches a script. `PATH` is already copied from that snapshot, " +
    "so `scripts.env.allow` cannot widen it — that key only adds NAMES to copy. Restart the " +
    "tool server to take your current environment, or pass an absolute path through the " +
    `step's \`env\`.${whose}`
  );
}

function pathEnvName(env: ScriptEnv): string | undefined {
  if (env.PATH !== undefined) return "PATH";
  if (process.platform !== "win32") return undefined;
  return Object.keys(env).find((name) => name.toLowerCase() === "path");
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

export function scriptVerdict(
  result: FlowScriptResult
): Pick<FlowScriptStepOutcome, "status" | "reason"> {
  const notes = result.notes.join(" ");
  if (result.ok) return { status: "pass", ...(notes ? { reason: notes } : {}) };
  const failure = result.failure;
  const message = failure?.message ?? "Script failed without a reason.";
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
