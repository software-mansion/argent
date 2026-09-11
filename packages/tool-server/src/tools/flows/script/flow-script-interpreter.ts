/**
 * Finds the bash a `.sh` script step runs under, once per step.
 *
 * Not memoized, for the reason the executor's bounds are not: `scripts.bash` is
 * configuration, and editing it takes effect on the next request. The lookup
 * shells out twice — once through `commandOnPath` for the PATH answer, once to
 * ask the candidate for its own version — and costs a few milliseconds against
 * a step that already starts a process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { win32 as pathWin32 } from "node:path";
import {
  configDocumentProblem,
  configFilePath,
  getConfigValueByKey,
  WINDOWS_ROOTED_PATH_RE,
} from "@argent/configuration-core";
import { commandOnPath } from "../../../utils/command-on-path";

const BASH_CONFIG_KEY = "scripts.bash";

/**
 * What the probe below asks a candidate to print. `BASH_VERSION` is set by bash
 * and by nothing else, so a shell that is not bash answers with the marker and
 * an empty version — which the pattern refuses. The leading newline keeps a
 * candidate that greets on stdout from running into the marker's own line.
 */
const BASH_PROBE_COMMAND = 'printf \'\\n%s%s\\n\' "argent-bash-version:" "${BASH_VERSION}"';

const BASH_PROBE_MARKER = /^argent-bash-version:\S/;

const BASH_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long the candidate is given to die after the SIGTERM above, before it is
 * killed. `spawn`'s own `timeout` option sends one signal and never escalates,
 * so a candidate that ignores SIGTERM — a wrapper, a version-manager shim —
 * held the step with nothing left to end it: this lookup runs BEFORE the fork,
 * so the step's own time limit has not started. The request's abort does reach
 * the wait — {@link askForBashVersion} listens for one — but only a client that
 * cancels fires it, and a request nobody cancels has this grace and nothing
 * else.
 */
const BASH_PROBE_FORCE_GRACE_MS = 1_000;

/**
 * How long the answer is waited for once the candidate itself has exited. A
 * candidate's standard output is inherited by everything it starts, so waiting
 * for that pipe to CLOSE waits for the last of those processes rather than for
 * the candidate — a shim that backgrounds one job held the step for as long as
 * the job ran. The marker is written before the candidate exits, so this window
 * is only for the read to catch up.
 */
const BASH_PROBE_SETTLE_MS = 250;

/**
 * How much of ONE line of the candidate's standard output is kept.
 *
 * A window on the whole output is a window the answer falls out of, whichever
 * end it is on, because a wrapper can print on either side of the bash it runs:
 * a head window lost the marker to a wrapper that greeted with 4 KiB before
 * `exec`ing a real bash, and a tail window lost it to a wrapper that RUNS bash
 * and then prints — to clean up, or to exit with bash's own status — where 4058
 * trailing characters passed and 4059 was refused as "not a bash". On the
 * search path the same cut is silent: the step ran under the NEXT candidate,
 * which on a Mac is Apple's 3.2.
 *
 * So nothing is windowed. `BASH_PROBE_COMMAND` puts the marker alone on a line
 * of its own, the lines are read as they arrive, and only the unfinished last
 * line is held — capped here, at its head, which is where a marker would be.
 */
const BASH_PROBE_MAX_CHARS = 4 * 1024;

/**
 * How much of the first line a refused candidate wrote to stderr the refusal
 * quotes. A version-manager shim says there why it ran no bash - "No version is
 * set for command bash" - and that names the remedy the refusal cannot. The
 * first line, because asdf follows it with the versions it has, one per line.
 */
const BASH_PROBE_STDERR_CHARS = 300;

const POSIX_FIXED_LOCATIONS = ["/bin/bash", "/usr/bin/bash"];

function configuredBash(): string | undefined {
  return getConfigValueByKey(BASH_CONFIG_KEY) as string | undefined;
}

/**
 * Where bash comes from, first hit wins:
 *
 * 1. `scripts.bash`, from the global config file. A value that is READ and is
 *    unusable REFUSES the step rather than falling through — a wrong path
 *    papered over by a fallback that happens to exist on this machine is a flow
 *    that breaks in CI with nothing in the configuration to show why. A
 *    document that could not be read at all is a different thing: the key may
 *    never have been set, so the search runs and the step carries a note
 *    saying the configuration was lost. Silence was the third outcome, and the
 *    one this promise denies.
 * 2. `bash` on the tool server's PATH — "the bash your terminal would run",
 *    which on a Mac with Homebrew is 5.x and on a bare one is Apple's 3.2. The
 *    script resolves its own tools against that same PATH on POSIX; on Windows
 *    it does not, because Git for Windows' `bash.exe` is a wrapper that
 *    prepends its own `mingw64\bin`, `usr\bin` and `%HOME%\bin` first.
 * 3. Fixed locations, for an editor-spawned server with a short login PATH.
 *
 * On Windows every candidate under `%SystemRoot%` is dropped at each of the
 * three: `System32\bash.exe` is the WSL launcher, it runs the file inside a
 * Linux distribution where the project path, the environment and
 * `$ARGENT_OUTPUT` do not exist, and it is early on every PATH.
 */
export async function resolveBashInterpreter(
  probeEnv: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  probeCwd?: string
): Promise<{ path: string; note?: string } | { problem: string } | { cancelled: true }> {
  if (signal?.aborted) return { cancelled: true };
  const lost = configDocumentProblem("global");
  const configured = configuredBash();
  if (configured !== undefined) {
    const problem =
      interpreterProblem(configured) ??
      (await notBashProblem(configured, probeEnv, signal, probeCwd));
    if (signal?.aborted) return { cancelled: true };
    return problem
      ? {
          problem:
            `The configured bash (${BASH_CONFIG_KEY} = ${configured}, from ` +
            `${configFilePath("global")}) ${problem}. Point ${BASH_CONFIG_KEY} at a bash ` +
            `executable, or unset it to use the one on this host's PATH.`,
        }
      : { path: configured };
  }

  const rejected: string[] = [];
  for (const candidate of await bashSearchPath()) {
    const shape = interpreterProblem(candidate);
    if (shape) {
      if (!shape.startsWith("is the WSL launcher") && fileExists(candidate)) {
        rejected.push(`${candidate} ${shape}`);
      }
      continue;
    }
    const problem = await notBashProblem(candidate, probeEnv, signal, probeCwd);
    if (signal?.aborted) return { cancelled: true };
    if (!problem) {
      const notes = [
        ...(rejected.length > 0 ? [refusedFirstNote(candidate, rejected)] : []),
        ...(lost ? [lostConfigNote(lost)] : []),
      ];
      return { path: candidate, ...(notes.length > 0 ? { note: notes.join(" ") } : {}) };
    }
    rejected.push(`${candidate} ${problem}`);
  }

  return { problem: `${notFoundMessage(rejected)}${lost ? ` ${lostConfigNote(lost)}` : ""}` };
}

function refusedFirstNote(ran: string, rejected: readonly string[]): string {
  return (
    `The script ran under ${ran}, because the search refused what it found first: ` +
    `${rejected.join("; ")}. Fix that candidate, or set ${BASH_CONFIG_KEY} to the absolute ` +
    `path of the bash to use.`
  );
}

function lostConfigNote(problem: string): string {
  return (
    `The global configuration was not read, so a ${BASH_CONFIG_KEY} in it did not apply to ` +
    `this step: ${problem}.`
  );
}

async function notBashProblem(
  candidate: string,
  probeEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  cwd?: string
): Promise<string | null> {
  const answer = await askForBashVersion(candidate, probeEnv, signal, cwd);
  if (answer.answered) return null;
  if (answer.signal) {
    return answer.stoppedByCheck
      ? `did not answer when it was asked for its version within ` +
          `${BASH_PROBE_TIMEOUT_MS / 1_000} seconds, and was stopped with ${answer.signal}`
      : `answered nothing when it was asked for its version, and died from ${answer.signal}`;
  }
  return (
    "is not a bash: running it printed no $BASH_VERSION, so a `.sh` step would report the " +
    "document it was seeded with rather than the one the script writes" +
    (answer.failure ? ` (${answer.failure})` : "") +
    (answer.stderr ? ` (it wrote to stderr: ${answer.stderr})` : "")
  );
}

/**
 * The names that make bash do something of its own before it reads the command
 * it was given: `BASH_ENV` and `ENV` each name a file it SOURCES, and
 * `SHELLOPTS` and `BASHOPTS` turn options on at startup.
 *
 * Kept out of the version probe, and only out of it. Not one of them can change
 * the answer to "does this print a `$BASH_VERSION`", so nothing about the step
 * is lost by asking without them - and each of them can stop the probe
 * answering at all, which reads as a host with no usable bash.
 */
const BASH_STARTUP_STEERING = ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"];

/** One environment with those names taken out, whatever case they are in. */
function withoutBashStartupSteering(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const steering = new Set(BASH_STARTUP_STEERING.map((name) => name.toLowerCase()));
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!steering.has(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

function askForBashVersion(
  candidate: string,
  probeEnv: NodeJS.ProcessEnv,
  signal_?: AbortSignal,
  cwd?: string
): Promise<{
  answered: boolean;
  signal: NodeJS.Signals | null;
  stoppedByCheck: boolean;
  failure?: string;
  stderr?: string;
}> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(candidate, ["-c", BASH_PROBE_COMMAND], {
        // The environment the STEP's bash gets, not the tool server's. The two
        // diverged in both directions: `BASH_ENV` is deliberately outside the
        // step allowlist - it is the one variable that changes what a
        // non-interactive `bash -c` does - so a host that exported it had every
        // candidate refused for a file the step's bash could never have read,
        // and the remedy the refusal names went through the same probe; and in
        // the other direction the candidate is an arbitrary executable named
        // `bash`, and inheriting here handed it the bearer token, the port and
        // every `ARGENT_SECRET_*` value the allowlist exists to keep out of a
        // script's reach.
        //
        // Minus the startup steering a flow's own `env` may now set, which is
        // the third direction. The reference blesses those names, and rightly -
        // they steer the interpreter of the SCRIPT, and an author who sets one
        // meant to - but this spawn is not the script. A `BASH_ENV` preamble
        // that ends the shell (`set -e` and a `command -v` finding nothing is
        // enough) aborts the probe before its marker, and every candidate is
        // then rejected as "not a bash". The step it refuses would have run:
        // the exchange is created AFTER this call, so such a preamble sees no
        // `$ARGENT_OUTPUT` here and does see one there.
        env: withoutBashStartupSteering(probeEnv),
        // The step's own directory, for the same reason: a version-manager
        // shim picks its bash from the directory it starts in - asdf reads
        // `.tool-versions` there - so a shim probed from the tool server's own
        // directory was refused while the step would have run it as bash 5,
        // and the search went on to /bin/bash.
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      resolve({ answered: false, signal: null, stoppedByCheck: false, failure: firstLine(err) });
      return;
    }
    let pending = "";
    let answered = false;
    let firstErr = "";
    let pendingErr = "";
    let settled = false;
    let killedWith: NodeJS.Signals | null = null;
    const timers: NodeJS.Timeout[] = [];
    const answer = (signal: NodeJS.Signals | null, failure?: string) => {
      if (settled) return;
      settled = true;
      const stoppedByCheck = killedWith !== null;
      for (const timer of timers) clearTimeout(timer);
      signal_?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      if (BASH_PROBE_MARKER.test(pending)) answered = true;
      const stderr = (firstErr || pendingErr).trim();
      resolve({
        answered,
        signal,
        stoppedByCheck,
        ...(failure === undefined ? {} : { failure }),
        ...(stderr ? { stderr } : {}),
      });
    };
    const onAbort = () => {
      killedWith = "SIGKILL";
      stopCandidate(child, "SIGKILL");
      answer("SIGKILL");
    };
    signal_?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (BASH_PROBE_MARKER.test(line)) answered = true;
      }
      if (pending.length > BASH_PROBE_MAX_CHARS) {
        pending = pending.slice(0, BASH_PROBE_MAX_CHARS);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (firstErr) return;
      const lines = (pendingErr + chunk).split("\n");
      pendingErr = (lines.pop() ?? "").slice(0, BASH_PROBE_STDERR_CHARS);
      firstErr = lines.find((line) => line.trim())?.slice(0, BASH_PROBE_STDERR_CHARS) ?? "";
    });
    child.on("error", (err) => answer(null, firstLine(err)));
    // The answer is on stdout, so a candidate that exited with its stdout ended
    // and the marker on it is answered at once: `close` waits for stderr too,
    // which a job the candidate started can hold. A candidate with no marker is
    // being refused, and the refusal quotes stderr, so it still waits for
    // `close` or the settle - a line that a `tee` in front of its stderr writes
    // after the candidate exits is read, not cut off.
    let exitSignal: NodeJS.Signals | null | undefined;
    let stdoutEnded = false;
    const answerIfDone = () => {
      if (exitSignal === undefined || !stdoutEnded) return;
      if (answered || BASH_PROBE_MARKER.test(pending)) {
        setImmediate(() => answer(exitSignal ?? null));
      }
    };
    child.stdout?.on("end", () => {
      stdoutEnded = true;
      answerIfDone();
    });
    child.on("exit", (_code, signal) => {
      const died = signal ?? killedWith;
      exitSignal = died;
      timers.push(setTimeout(() => answer(died), BASH_PROBE_SETTLE_MS));
      answerIfDone();
    });
    child.on("close", (_code, signal) => answer(signal ?? killedWith));
    timers.push(
      setTimeout(() => {
        killedWith = "SIGTERM";
        stopCandidate(child, "SIGTERM");
      }, BASH_PROBE_TIMEOUT_MS)
    );
    timers.push(
      setTimeout(() => {
        killedWith = "SIGKILL";
        stopCandidate(child, "SIGKILL");
        answer("SIGKILL");
      }, BASH_PROBE_TIMEOUT_MS + BASH_PROBE_FORCE_GRACE_MS)
    );
  });
}

function stopCandidate(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is gone, or was never led by this child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already reaped.
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
}

export async function bashSearchPath(): Promise<string[]> {
  const onPath = await commandOnPath("bash", isUsableCandidate);
  return withoutRepeats([...(onPath ? [onPath] : []), ...(await fixedLocations())]);
}

function withoutRepeats(candidates: string[]): string[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Every reason a candidate cannot be the interpreter, in the words the refusal
 * uses. Empty because the schema keeps every value that is PRESENT, so that a
 * blank one is refused here rather than read as an absent key; absolute because
 * a relative PATH entry gives `command -v` a relative answer that `spawn` would
 * resolve against the runner's own cwd; executable because a readable file is
 * not a runnable one — except on Windows, where `X_OK` succeeds for any file
 * and existence is the whole check.
 *
 * The two shape rules — absolute, and rooted on a drive under Windows — are the
 * ones `argent config set scripts.bash` applies before it writes, through the
 * same {@link WINDOWS_ROOTED_PATH_RE}. The filesystem checks below are this
 * side's alone: the write gate never touches the disk, and the value it stored
 * is read back on the host that RUNS the step, which may have gained or lost
 * the file since — a home directory restored onto a new machine is the ordinary
 * way. These checks also cover every candidate the PATH search offers, which no
 * write gate ever saw.
 */
function interpreterProblem(candidate: string): string | null {
  if (candidate === "") return "is empty";
  if (!platformPath().isAbsolute(candidate)) {
    return "is not an absolute path (a relative path would resolve against the tool server's own working directory)";
  }
  if (
    process.platform === "win32" &&
    !WINDOWS_ROOTED_PATH_RE.test(stripExtendedPrefix(candidate))
  ) {
    return (
      "names no drive (a path that begins with a slash or a backslash is rooted on whatever " +
      "drive the process is on, and the tool server and the script's own process are not on " +
      "the same one)"
    );
  }
  if (underSystemRoot(candidate)) {
    return (
      "is the WSL launcher under %SystemRoot%, which runs the script inside a Linux " +
      "distribution where the project path, the environment and $ARGENT_OUTPUT do not exist " +
      "(Git for Windows' bash.exe is the one to point at)"
    );
  }
  try {
    if (!fs.statSync(candidate).isFile()) return "is not a file";
  } catch {
    return "does not exist";
  }
  if (process.platform === "win32") return null;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
  } catch {
    return "is not executable";
  }
  return null;
}

function fileExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isUsableCandidate(candidate: string): boolean {
  return !underSystemRoot(candidate);
}

function platformPath(): typeof pathWin32 {
  return process.platform === "win32" ? pathWin32 : path.posix;
}

function underSystemRoot(candidate: string): boolean {
  if (process.platform !== "win32") return false;
  const root = pathWin32.resolve(process.env.SystemRoot ?? "C:\\Windows").toLowerCase();
  return spellingsOf(candidate).some((spelling) => {
    const resolved = pathWin32.resolve(spelling).toLowerCase();
    return resolved === root || resolved.startsWith(`${root}\\`);
  });
}

/**
 * Every name the same file answers to, because the test above is a comparison
 * of strings and Windows gives one file several. `\\?\` is the extended-length
 * prefix, which `path.resolve` keeps and so never matches the plain root; and
 * `C:\WINDOW~1\System32\bash.exe` is the 8.3 short name, which no lexical rule
 * can expand — only the filesystem knows it, and it answers through
 * `realpath.native`. A name that resolves to nothing is left as written: the
 * existence check below is what reports it.
 */
function spellingsOf(candidate: string): string[] {
  const stripped = stripExtendedPrefix(candidate);
  const spellings = [candidate, stripped];
  try {
    spellings.push(stripExtendedPrefix(fs.realpathSync.native(stripped)));
  } catch {
    // Not there, or a name the filesystem will not resolve.
  }
  return spellings;
}

function stripExtendedPrefix(candidate: string): string {
  if (/^\\\\[?.]\\UNC\\/.test(candidate)) return `\\\\${candidate.slice(8)}`;
  if (/^\\\\[?.]\\/.test(candidate)) return candidate.slice(4);
  return candidate;
}

/**
 * Git for Windows in the shapes its installers produce. `git.exe` on PATH is
 * the most reliable of them because it survives a per-user install into a
 * directory none of the environment names below point at: `<Git>\cmd\git.exe`
 * sits two levels above `<Git>\bin\bash.exe`.
 *
 * That derivation is the official installer's layout, and a package manager
 * puts a SHIM on PATH instead — `~\scoop\shims\git.exe`,
 * `C:\ProgramData\chocolatey\bin\git.exe` — two levels above which there is
 * no `bin\bash.exe`. Chocolatey installs Git for Windows itself, so
 * `ProgramFiles` below covers it; Scoop keeps its own tree, so its two roots
 * are named here.
 */
async function fixedLocations(): Promise<string[]> {
  if (process.platform !== "win32") return POSIX_FIXED_LOCATIONS;
  const candidates: string[] = [];
  const git = await commandOnPath("git");
  if (git && pathWin32.isAbsolute(git)) {
    // `<Git>\cmd\git.exe` and `<Git>\bin\git.exe` both sit two levels above
    // `<Git>\bin\bash.exe`. `<Git>\mingw64\bin\git.exe` sits three, and that
    // is what `where git` answers when the tool server was started from a Git
    // Bash terminal, or from an editor whose default shell is one — so both
    // depths are offered and the one that exists is taken.
    const above = pathWin32.dirname(pathWin32.dirname(git));
    candidates.push(pathWin32.join(above, "bin", "bash.exe"));
    candidates.push(pathWin32.join(pathWin32.dirname(above), "bin", "bash.exe"));
  }
  for (const base of [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA && pathWin32.join(process.env.LOCALAPPDATA, "Programs"),
  ]) {
    if (base) candidates.push(pathWin32.join(base, "Git", "bin", "bash.exe"));
  }
  for (const root of [
    process.env.SCOOP,
    process.env.USERPROFILE && pathWin32.join(process.env.USERPROFILE, "scoop"),
    process.env.SCOOP_GLOBAL,
    process.env.ProgramData && pathWin32.join(process.env.ProgramData, "scoop"),
  ]) {
    if (root) candidates.push(pathWin32.join(root, "apps", "git", "current", "bin", "bash.exe"));
  }
  return candidates;
}

function notFoundMessage(rejected: readonly string[]): string {
  const looked =
    process.platform === "win32"
      ? "PATH (skipping the WSL launcher under %SystemRoot%) and Git for Windows' usual install locations, Scoop's included"
      : `PATH, ${POSIX_FIXED_LOCATIONS.join(" and ")}`;
  const install =
    process.platform === "win32" ? "Install Git for Windows, which ships bash.exe" : "Install bash";
  if (rejected.length > 0) {
    return (
      `No bash this host offers could run the script: the executor looked at ${looked}, and ` +
      `refused what it found — ${rejected.join("; ")}. Fix the candidate above, or set ` +
      `${BASH_CONFIG_KEY} to the absolute path of a bash that answers.`
    );
  }
  return (
    `No bash was found on this host to run the script with: the executor looked at ${looked}. ` +
    `${install}, or set ${BASH_CONFIG_KEY} to an absolute path. The tool server's PATH is a ` +
    `snapshot from when it started, so a bash your terminal finds may still be absent here — ` +
    `restart the tool server after changing PATH.`
  );
}
