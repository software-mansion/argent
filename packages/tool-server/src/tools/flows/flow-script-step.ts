import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_FILE_NAME_PATTERN } from "@argent/registry";
import { hasScriptExtension, scriptInterpreter, type FlowStep, type ScriptEnv } from "./flow-utils";
import { canonicalFlowPath, resolveFlowRelativeFile } from "./flow-file-refs";
import {
  flowScriptExecutor,
  type FlowScriptFailureKind,
  type FlowScriptLogBudget,
  type FlowScriptResult,
  type FlowScriptRunNotes,
  type FlowScriptSecret,
} from "./script/flow-script-executor";
import { resolveScriptEnvSecrets } from "./script/flow-script-env";

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
  /**
   * Every environment value this invocation runs with, already layered by the
   * caller in the order {@link mergeScriptEnv} fixes — the step's own `env`
   * included, so this is the whole map and the step is not read again here.
   * `{{secret:NAME}}` placeholders are still unresolved: they are substituted
   * below, once, on the one path both callers share.
   */
  env?: ScriptEnv;
  /** Notes an earlier step of the same run already carried. */
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

  // The secret chain is anchored at the run's project, not at the tool server's
  // working directory: that is a snapshot from whatever spawned the server, and
  // an editor sets it to `/` or `$HOME`. Left to the default, a project's own
  // `.argent/secrets.env` and `.env` would never be found — on exactly the hosts
  // this feature is most used on. The chain reads those files on each call, so
  // a secret added while the server is up applies without a restart; the
  // server's own environment does not work that way.
  //
  // A name no source defines is an `error`, not a `fail`: the step never
  // started, and the fault is the host's missing secret rather than anything
  // the script did. The resolver's own message lists the available names and
  // every source it looked in, which is what the author acts on.
  let env: ScriptEnv;
  let secrets: FlowScriptSecret[];
  try {
    ({ env, secrets } = resolveScriptEnvSecrets(request.env ?? {}, { cwd: request.projectRoot }));
  } catch (err) {
    return { ran: "no", outcome: { status: "error", reason: errMsg(err) } };
  }

  const result = await flowScriptExecutor().execute({
    scriptPath: canonical,
    // Decided here from the CANONICAL path — the file the executor really runs —
    // and passed explicitly: the executor runs what it is told and never
    // inspects an extension. The spelling is not the same fact: a step written
    // as `aliased.sh` can be a symlink to a `.mjs`, and reading the extension
    // off the link would run JavaScript under bash and report exit code 127
    // with a hint about a missing tool.
    //
    // A canonical path that carries NO extension is the one case the target
    // cannot answer — `seed.sh -> ../tools/seed` is an ordinary way to name a
    // script — and `scriptInterpreter` would fall through to its `node` default
    // there. The step's own spelling is what stands in: the parser holds it to
    // `SCRIPT_FILE_NAME_PATTERN`, so it always carries one of the two.
    interpreter: scriptInterpreter(hasScriptExtension(canonical) ? canonical : target),
    output: {},
    ...(step.timeout !== undefined ? { timeoutMs: step.timeout } : {}),
    projectRoot: request.projectRoot,
    flowDir,
    ...(request.logBudget ? { logBudget: request.logBudget } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    // The values THIS step's `{{secret:NAME}}` placeholders resolved to, and
    // nothing else — not the whole resolvable chain, not the plaintext values
    // beside them. A secret the step never referenced is not in its
    // environment, so scanning its failure text for one finds nothing and
    // costs a walk over every failure.
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(request.runNotes ? { runNotes: request.runNotes } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  // Added to the executor's own notes rather than appended after the verdict:
  // this IS a note about the host, and `scriptVerdict` is where a note joins
  // the script's own message.
  const shellLimit = describeShellEnvironmentLimit(result, env);
  const verdict = scriptVerdict(
    shellLimit ? { ...result, notes: [...result.notes, shellLimit] } : result
  );
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

/**
 * How a shell says a command was not on `PATH`, in the shapes the shells write
 * it in. Each matches a whole LINE rather than the phrase inside it, AND a line
 * that ENDS the failure text. `execSync` folds the child's stderr into the
 * message it throws, so a script that greps an install log, asserts on an error
 * path, or wraps a build that failed on its own carries the words with nothing
 * missing — line-anchoring alone made a quoted shell line the best possible
 * match, and the note then ended that verdict with a confident instruction
 * pointing at the wrong subsystem.
 *
 * The tail anchor is what the note is bought with, and it buys less than it
 * looks like it does. What it rules out is a transcript that CONTINUES after
 * the shell line — a step that greps an install log and reports the lines
 * around the one it was looking for. It does not rule out a script sentence in
 * FRONT of one, which is the commoner shape: the script says what it was doing
 * and the captured stderr is appended last, so
 * `could not parse the captured log as JSON at position 0\nsh: 1: adb: command
 * not found` still earns the note. That is a shape where the note is usually
 * right — the command really was not found, and it is why the parse failed —
 * so it is left alone rather than tightened against. A missed note is the safe
 * direction, which is what the tail anchor picks when it is wrong.
 *
 * A shell line has a shape a sentence does not, and it is the shape that is
 * matched, not a length: the writer, then optionally a line number, then the
 * command, then the phrase and nothing after it —
 *
 *   sh: adb: command not found            bash, ksh, macOS /bin/sh
 *   /path/to/build.sh: line 3: adb: command not found
 *   /bin/sh: 1: adb: not found            dash, i.e. Debian/Ubuntu and CI
 *   zsh:1: command not found: adb         zsh puts the phrase first
 *
 * `not found` without `command` is dash's wording, and `/bin/sh` IS dash on
 * Debian and Ubuntu — which is what a bare `execSync` runs and what the unit
 * test workflow runs on, so the host where the note is most useful was the one
 * host it never appeared on. That wording is its own pattern, and it requires
 * the LINE NUMBER dash always writes: without it, `<a>: <b>: not found` is the
 * shape of an ordinary two-part application error — `fixture: users.json: not
 * found`, `HTTP 404: /api/users: not found` — and a step that failed on a
 * missing fixture would end its verdict with a confident instruction to restart
 * the tool server. Script steps exist to seed databases and read fixtures,
 * which is exactly where that message shape lives.
 *
 * The line number alone does not separate the two: a THREE-part error with a
 * numeric second field has it as well (`request failed: 404: /api/users: not
 * found`), and so does an application that writes a PATH in front of its own
 * line number — `fixtures/orders.json: 12: customerId: not found` is the same
 * missing-fixture shape one field longer. Asking merely for a path in front of
 * the number therefore separates nothing.
 *
 * What dash writes there is the shell it is, or the script it is running: the
 * name ends in `sh`, either as the whole name (`sh`, `bash`, `dash`, `ksh`,
 * `zsh`, `ash`) or as the extension a `.sh` file carries. That is what the
 * pattern asks for, and it is the fact a fixture path does not have. A script
 * named without an extension — `/usr/local/bin/seed: 3: adb: not found` — is
 * missed by it, and a missed note is the safe direction.
 *
 * The end anchor is what makes the phrase safe to accept at all: `for: command
 * not found never appeared in it` has the words but keeps going. Nothing caps
 * how long the line may be, either — bash prefixes the failing script's own
 * path, and a deep enough checkout would push a genuine miss past a fixed cap.
 */
const COMMAND_NOT_FOUND_SIGNATURES: readonly RegExp[] = [
  /^[^\n:]+: (?:line )?(?:\d+: )?[^\n:]+: command not found[ \t\r]*$(?![\s\S]*\S)/im,
  /^(?:[^\n:]*[/\\])?(?:[A-Za-z0-9_.+-]*\.)?(?:ba|da|k|z|a)?sh: (?:line )?\d+: [^\n:]+: ?not found[ \t\r]*$(?![\s\S]*\S)/im,
  /^[^\n:]+:(?:\d+:)? command not found: [^\s:]+[ \t\r]*$(?![\s\S]*\S)/im,
  // cmd.exe writes TWO lines, and both are asked for, ending the failure text
  // the way the three signatures above do. The opening quote alone let any
  // sentence QUOTING the message match — `AssertionError: 'foo' is not
  // recognized as an internal or external command`, or a step that parsed a
  // Windows build log and reported what it read — because `/m` anchors `^` at
  // every line start and nothing guarded the other end.
  /^'[^\n']+' is not recognized as an internal or external command,\r?\noperable program or batch file\.[ \t\r]*$(?![\s\S]*\S)/im,
];

/**
 * Node's own spelling, for a command it spawned without a shell. Read to the
 * end of the line rather than to the first space: a path with a space in it is
 * the flagship case (`spawnSync /Applications/Android Studio.app/… ENOENT`).
 *
 * It is kept apart from the shell wordings because it does not say the same
 * thing. Node raises this when the COMMAND is missing and, identically, when
 * the `cwd` it was given does not exist — same `syscall`, same `path`, same
 * message — so a note claiming a command was missing would send an author
 * looking for one that was there all along, at an absolute path. Bare `ENOENT`
 * is still not matched at all: that is also how a missing data file reads.
 *
 * One token between the two words, so `spawn of the seeder finished; reading
 * fixtures/orders.json failed: ENOENT` — a missing data file, the very shape
 * the paragraph above promises is not matched — no longer is. Node writes a
 * path there and never sentence punctuation.
 */
const SPAWN_ENOENT = /spawn(?:Sync)? (?:[A-Za-z]:)?[^\n:;,]+ ENOENT/;

/**
 * A `.sh` says it in an exit code, not in words.
 *
 * Its stdout and stderr are drained and discarded, so the shell's own
 * `command not found` line never reaches this side unless the script copied it
 * into `$ARGENT_REASON` itself — and a script that meant to run `adb` wrote no
 * error handling for a case it does not know is possible. What always arrives
 * is code 127, which is bash's own name for exactly this. Matched on the
 * sentence the runner composes rather than on a bare `127`, which is also an
 * ordinary exit code for a script that chose it.
 */
const BASH_COMMAND_NOT_FOUND = /^The script exited with code 127 \(bash: /m;

/**
 * The note a `command not found` earns, or null when the failure was something
 * else.
 *
 * On its own that failure points nowhere: the command plainly exists, and works
 * in the author's own shell. What it does not say is that the tool server is a
 * long-lived process whose environment — `PATH` included — is a snapshot from
 * its first start, so a later `export`, or an editor that spawned the server
 * with a short login `PATH`, leaves a version-manager shim or an `adb` out of
 * reach.
 *
 * `scripts.env.allow` is NOT one of the remedies, though it reads like one: it
 * widens which names are copied out of that snapshot, and `PATH` is on the
 * built-in allowlist already, so naming it there does nothing. Restarting the
 * server is what replaces the snapshot.
 *
 * None of that holds when the RUN set `PATH` itself, and this feature gives it
 * four ways to — the flow's `env:`, a fragment's, `--env`, the step's own. That
 * value replaces the snapshot outright, so the snapshot is not what the command
 * was looked up in, restarting the server changes nothing, and the one place
 * the author has to look is the one the paragraph above excludes. `env` names
 * the cause in that case instead.
 */
function describeShellEnvironmentLimit(result: FlowScriptResult, env: ScriptEnv): string | null {
  if (result.ok) return null;
  // The FAILURE only. Nothing a script prints is reported, and a script that
  // greps an install log, asserts on an error path, or echoes a CI transcript
  // could carry this phrase back while failing for an unrelated reason.
  const text = result.failure?.message ?? "";
  // Bash FIRST, and the order is load-bearing. A `.sh` is told to explain
  // itself by writing `$ARGENT_REASON`, and the way a shell script explains a
  // failed command is to send stderr there — which puts the shell's own wording
  // into the same message as the runner's own 127 hint. Tested the other way
  // round, such a step matched the `.mjs` branch and earned a prefix on top of
  // a hint that had already named the cause.
  const what = BASH_COMMAND_NOT_FOUND.test(text)
    ? // Nothing: the runner's own 127 hint sits immediately before this note
      // and has already said what the code means.
      ""
    : COMMAND_NOT_FOUND_SIGNATURES.some((signature) => signature.test(text))
      ? "A command was not found. "
      : SPAWN_ENOENT.test(text)
        ? "A command was not found — or the working directory it was given does not exist, " +
          "which Node reports the same way. "
        : null;
  if (what === null) return null;
  const ownPath = pathEnvName(env);
  if (ownPath !== undefined) {
    return (
      `${what}This run sets \`${ownPath}\` itself, through an \`env\` value, and that value — ` +
      "not the tool server's environment — is the whole search path the command was looked " +
      `up in: ${JSON.stringify(env[ownPath])}. Widen it, or pass an absolute path.`
    );
  }
  return (
    `${what}The tool server keeps the environment it started with, so an ` +
    "`export` made later never reaches a script. `PATH` is already copied from that snapshot, " +
    "so `scripts.env.allow` cannot widen it — that key only adds NAMES to copy. Restart the " +
    "tool server to take your current environment, or pass an absolute path through the " +
    "step's `env`."
  );
}

/**
 * The name this environment spells `PATH` under, or undefined when it sets none.
 *
 * Case-folded on Windows only, which reads one variable however it is spelled —
 * the same rule `mergeScriptEnv` and `buildChildEnv` follow, and for the same
 * reason: a `Path` there IS the search path.
 */
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
