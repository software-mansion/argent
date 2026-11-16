import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalFlowPath,
  resolveFlowRelativeFile,
  SCRIPT_FILE_NAME_PATTERN,
} from "@argent/registry";
import type { FlowStep } from "./flow-utils";
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

  // Asked of the name the flow spells, not of `canonical`: Node picks a module's
  // format from the real path's extension, but a symlink that renames a file
  // across the TypeScript line is not a layout worth a second rule, and the
  // load failure Node reports for it names the file.
  if (isTypeScriptScript(suppliedBase) && !nodeStripsTypes()) {
    return {
      ran: "no",
      outcome: {
        status: "error",
        reason:
          `Script "${target}" is TypeScript, and the tool-server runs on Node.js ` +
          `${process.versions.node}, which cannot run it. Start the tool-server on Node.js ` +
          `${TYPESCRIPT_MIN_NODE} or later, or write the script as ` +
          `${javaScriptSpelling(suppliedBase)}.`,
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
  const tail = (result.ok ? "" : cjsRenameNote(result.failure, canonical)) + frames;
  return {
    outcome: {
      ...verdict,
      ...(tail && verdict.reason !== undefined ? { reason: verdict.reason + tail } : {}),
      ...(result.log ? { scriptLog: result.log } : {}),
      ...(result.logTruncated ? { scriptLogTruncated: true } : {}),
    },
    result,
    ran: scriptRan(result),
  };
}

function isTypeScriptScript(base: string): boolean {
  return base.endsWith(".ts") || base.endsWith(".mts");
}

/**
 * What a TypeScript script is rewritten as on a Node that cannot run it. An
 * `.mts` file is an ES module and so is `.mjs`. A `.ts` file has whatever
 * module type Node gives a `.js` file beside it, so `.js` is its twin — but
 * the releases that cannot strip types are also, mostly, the ones that do not
 * read the syntax of a `.js` file under a package.json with no `type`, and
 * there only `.mjs` runs an `import`.
 */
function javaScriptSpelling(base: string): string {
  return base.endsWith(".mts") ? "a .mjs file" : "a .js file, or a .mjs file if it is an ES module";
}

/**
 * Node ends its error for a `require` in a `.js` file it read as an ES module
 * with advice to rename the file `.cjs` — an extension the parser refuses
 * (`SCRIPT_FILE_EXTENSIONS`), so on a step line the advice leads straight into
 * a second failure. The note says so, and what does work.
 *
 * Only for the script itself: the same error from a file the script loads is
 * about a file that may be renamed, and Node's advice holds for it. The top
 * frame says which, and an ES module's frame names its file as a URL.
 */
function cjsRenameNote(failure: FlowScriptResult["failure"], canonical: string): string {
  if (!failure?.stack || !NODE_CJS_RENAME_ADVICE.test(failure.message)) return "";
  const top = failure.stack.split("\n").find((line) => line.trim().startsWith("at "));
  if (!top?.includes(`${pathToFileURL(canonical).href}:`)) return "";
  return " A script step does not accept a .cjs file: use import in the script instead.";
}

const NODE_CJS_RENAME_ADVICE = /rename it to use the '\.cjs' file extension/;

/** The first release of the oldest line that runs TypeScript with no flag. */
const TYPESCRIPT_MIN_NODE = "22.18";

/**
 * Whether this Node runs a TypeScript file as it stands: 22.18 on the 22 line,
 * 23.6 on the 23 line, and every release after. Older ones either cannot or
 * need `--experimental-strip-types`.
 *
 * Read from the version rather than from `process.features.typescript`: the
 * script's process is this same binary, but the executor gives it its own
 * `execArgv` and drops `NODE_OPTIONS`, so a flag that turned stripping on or
 * off for the tool-server says nothing about the child.
 *
 * Refusing up front is what makes this a host error. Left to Node, an old
 * release reports `ERR_UNKNOWN_FILE_EXTENSION` from the loader, which reads as
 * the script's own load failure and names nothing the author can change.
 *
 * Exported for its test.
 */
export function nodeStripsTypes(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major >= 24) return true;
  if (major === 23) return minor >= 6;
  return major === 22 && minor >= 18;
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

/**
 * A frame in the host's own machinery, not in anything the author wrote: the
 * runner, and every frame Node's own code is at. The second is not only
 * `node:internal` — a CommonJS script is loaded through
 * `node:diagnostics_channel`, which puts that frame under every one of its
 * failures, and a callback reaches the script through `node:events` or
 * `node:timers`.
 */
function isHostFrame(frame: string): boolean {
  return (
    NODE_FRAME_RE.test(frame) ||
    frame.includes("node:internal") ||
    frame.includes("flow-script-runner.mjs") ||
    frame.includes("flow-script-watchdog")
  );
}

/** A frame whose location is a `node:` builtin: `at f (node:x:1:2)` or `at node:x:1:2`. */
const NODE_FRAME_RE = /(?:^at (?:async )?|\()node:[^\s()]+\)?$/;

/**
 * `file:///abs/path/seed.mjs:1:30` reads as `scripts/seed.mjs:1:30`. The frames
 * go on ONE step line, so the anchor is the run's own `project_root` — the
 * directory the script also ran in. A script outside it keeps its absolute
 * path, because a `..` chain says less than the path does.
 *
 * An ES module's frame names its file as that URL and a CommonJS module's as
 * the bare path, `/abs/path/seed.js:1:30`. Both come out the same.
 *
 * `roots` is that directory both as given and canonicalized, because only one
 * of the two ever matches: Node resolves a module to its REAL path, so every
 * frame is canonical, while `project_root` arrives as the caller spelled it. On
 * macOS a project under `/var` (or any symlinked parent) is the ordinary case
 * of the two differing.
 */
function readableFrame(frame: string, roots: readonly string[]): string {
  const withoutUrls = frame.replace(/file:\/\/[^\s)]+/g, (match) => {
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
  return roots.reduce(withoutRoot, withoutUrls);
}

/**
 * Drops `root` from the front of each bare path in a frame. A path starts a
 * frame's location, so it follows `at ` or an opening parenthesis; anchoring
 * there keeps one root from matching inside the other, which it does whenever
 * the canonical one only adds a prefix (`/private/var/…` over `/var/…`).
 */
function withoutRoot(frame: string, root: string): string {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Windows compares paths without case, and a drive letter's case is whatever
  // the caller typed.
  const flags = process.platform === "win32" ? "gi" : "g";
  return frame.replace(new RegExp(`(^at (?:async )?|\\()${escaped}`, flags), "$1");
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
