import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
  // load failure Node reports for it is read below.
  //
  // A run asks this of every script step before its first one (see
  // `typeScriptScriptRefusal`); asked again here for the callers that have no
  // such gate — a recorded step, and a step of a `run:` fragment.
  const refusal = await typeScriptScriptRefusal(target);
  if (refusal !== undefined) {
    return { ran: "no", outcome: { status: "error", reason: refusal } };
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

  const roots = result.ok
    ? []
    : [request.projectRoot, await canonicalFlowPath(request.projectRoot)];
  const hostLimit = await typeScriptLoadRefusal(target, result, roots);
  const verdict: Pick<FlowScriptStepOutcome, "status" | "reason"> =
    hostLimit !== undefined
      ? { status: "error", reason: [hostLimit, ...result.notes].join(" ") }
      : scriptVerdict(result);
  // A host limit has no frame of the script's to show: Node stopped in its own
  // loader, before a line of the file it could not read.
  const frames =
    result.ok || hostLimit !== undefined ? "" : scriptFrames(result.failure?.stack, roots);
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

function isTypeScriptScript(base: string): boolean {
  return base.endsWith(".mts");
}

/** The first release of the oldest line that runs TypeScript with no flag. */
const TYPESCRIPT_MIN_NODE = "22.18";

/**
 * Whether this Node release runs a TypeScript file as it stands: 22.18 on the
 * 22 line, 23.6 on the 23 line, and every release after. Older ones either
 * cannot or need `--experimental-strip-types`.
 *
 * The release is not the whole answer — see {@link typeScriptGap}, which asks
 * the binary — but it is the one that says WHY a host cannot, and the one left
 * when the binary could not be asked.
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
 * Why a script process on this host cannot run TypeScript: its Node release
 * does not, or the release does and this build of it was compiled without the
 * support. Undefined when it can.
 */
type TypeScriptGap = "release" | "build";

/**
 * `strips` is the executor's answer from a process started the way a script's
 * is (`FlowScriptExecutor.stripsTypes`), and it decides: a `true` runs the
 * script whatever the release table says. The release only explains a host
 * that cannot, and stands in when the binary could not be asked.
 *
 * The binary is asked because the release is not enough. Debian and Ubuntu
 * build their `nodejs` package without the stripper, so a 22.22 or a 24 from
 * `apt` reports `process.features.typescript` as `false` and fails an `.mts`
 * with `ERR_UNKNOWN_FILE_EXTENSION` — which reads as the script's own load
 * failure and names nothing the author can change. Refusing up front is what
 * makes either gap a host error.
 *
 * Exported for its test.
 */
export function typeScriptGap(
  strips: boolean | undefined,
  version: string = process.versions.node
): TypeScriptGap | undefined {
  if (strips === true) return undefined;
  if (!nodeStripsTypes(version)) return "release";
  return strips === false ? "build" : undefined;
}

/**
 * The refusal for a script this host cannot run. `subject` opens the sentence
 * with what the flow asked for.
 *
 * The recovery names `argent server stop` because switching Node alone changes
 * nothing: a tool-server that is already up is reused whatever Node the next
 * command runs on, so the same refusal would come back naming the old release.
 *
 * Exported for its test.
 */
export function typeScriptRefusalReason(
  subject: string,
  gap: TypeScriptGap,
  version: string = process.versions.node
): string {
  const host =
    gap === "release"
      ? `the tool-server runs on Node.js ${version}, which cannot run it. Node.js runs ` +
        `TypeScript from ${TYPESCRIPT_MIN_NODE}, except on 23.0 to 23.5. Stop the tool-server ` +
        `with \`argent server stop\`, then run Argent on such a Node.js,`
      : `the tool-server runs on a build of Node.js ${version} that cannot run it: the build ` +
        `has no TypeScript support, like the nodejs package of Debian and Ubuntu. Stop the ` +
        `tool-server with \`argent server stop\`, then run Argent on a Node.js from nodejs.org,`;
  return `${subject}, and ${host} or use JavaScript (.mjs) for the script and for the files it imports.`;
}

/**
 * Why this host cannot run the script a `script:` step names, or undefined: a
 * TypeScript file, on a host with a {@link TypeScriptGap}. A script that is not
 * TypeScript costs nothing to ask about.
 *
 * The answer is fixed before a run's first step, so the runner asks it of every
 * script step up front — a refusal that waited for the step would land after
 * earlier steps had seeded data or driven the device.
 */
export async function typeScriptScriptRefusal(target: string): Promise<string | undefined> {
  if (!isTypeScriptScript(path.posix.basename(target))) return undefined;
  const gap = typeScriptGap(await flowScriptExecutor().stripsTypes());
  return gap && typeScriptRefusalReason(`Script "${target}" is TypeScript`, gap);
}

/** Node's load failure for a TypeScript file it has no loader for, with the file. */
const UNKNOWN_TYPESCRIPT_FILE_RE = /^Unknown file extension "\.[mc]?ts" for (.+)$/;

/**
 * The same refusal, for TypeScript the step's own name does not show: a file
 * the script imports. Nothing before the run can see it, so it is read back
 * from Node's failure — `ERR_UNKNOWN_FILE_EXTENSION` for a TypeScript
 * extension, on a host with a {@link TypeScriptGap}. Left as it came, that is
 * the host's limit reported as the script's fault.
 */
async function typeScriptLoadRefusal(
  target: string,
  result: FlowScriptResult,
  roots: readonly string[]
): Promise<string | undefined> {
  if (result.ok || result.failure?.kind !== "load") return undefined;
  const file = UNKNOWN_TYPESCRIPT_FILE_RE.exec(result.failure.message)?.[1];
  if (file === undefined) return undefined;
  const gap = typeScriptGap(await flowScriptExecutor().stripsTypes());
  return (
    gap &&
    typeScriptRefusalReason(
      `Script "${target}" loads the TypeScript file "${readablePath(file, roots)}"`,
      gap
    )
  );
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
    // The column is optional: the place Node names for a syntax error is a
    // line alone (see `STACK_PLACE_RE`).
    const split = /^(.*?)(:\d+(?::\d+)?)$/.exec(match);
    const url = split ? split[1]! : match;
    const position = split ? split[2]! : "";
    let file: string;
    try {
      file = fileURLToPath(url);
    } catch {
      return match;
    }
    return `${readablePath(file, roots)}${position}`;
  });
}

/** `file` relative to the first of `roots` that holds it, else as it stands. */
function readablePath(file: string, roots: readonly string[]): string {
  for (const root of roots) {
    const relative = path.relative(root, file);
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }
  }
  return file;
}

/**
 * The place a stack opens with when Node refused the SOURCE rather than ran
 * it: `file:///abs/svc.mts:2`, then the line and a caret under it, then the
 * error. Node writes it for TypeScript syntax it cannot strip — an `enum`, a
 * parameter property — and for an import of a name the other module does not
 * export. Every `at` line under it is the loader's own, so without this line
 * the reason names no file at all.
 */
const STACK_PLACE_RE = /^file:\/\/\S+:\d+$/;

/**
 * The frames of a failed script, as a block appended to its message. Newline
 * separated on purpose: `oneLineReason` escapes them, so the block reads as
 * `\n    at …` on the step's own line and a reader can still tell one frame
 * from the next. The stack's first line is dropped — it only repeats the
 * message the reason already opens with — unless it is the place of a syntax
 * error, which then leads the block as a frame of its own.
 */
function scriptFrames(stack: string | undefined, roots: readonly string[]): string {
  if (!stack) return "";
  const frames: string[] = [];
  let dropped = 0;
  const lines = stack.split("\n");
  const place = lines[0]!.trim();
  if (STACK_PLACE_RE.test(place)) frames.push(`    at ${readableFrame(place, roots)}`);
  for (const line of lines) {
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
