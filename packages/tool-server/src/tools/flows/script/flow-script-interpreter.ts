/**
 * Finds the bash a `.sh` script step runs under, once per step. Not memoized:
 * `scripts.bash` is configuration, and an edit takes effect on the next request.
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
 * Only bash sets `BASH_VERSION`, so another shell prints an empty version, which
 * the marker refuses. The leading newline separates the marker from a greeting.
 */
const BASH_PROBE_COMMAND = 'printf \'\\n%s%s\\n\' "argent-bash-version:" "${BASH_VERSION}"';

const BASH_PROBE_MARKER = /^argent-bash-version:\S/;

const BASH_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long a candidate gets to die after SIGTERM before SIGKILL: `spawn`'s own
 * `timeout` never escalates, and the step's time limit has not started yet.
 */
const BASH_PROBE_FORCE_GRACE_MS = 1_000;

/**
 * How long the answer is waited for after the candidate exits. Not the pipe's
 * close, which waits for every process the candidate started.
 */
const BASH_PROBE_SETTLE_MS = 250;

/**
 * How much of ONE line of the candidate's stdout is kept. Output is read line by
 * line and never windowed as a whole, since a wrapper can print any amount
 * before or after the bash it runs.
 */
const BASH_PROBE_MAX_CHARS = 4 * 1024;

/**
 * How much of a refused candidate's first stderr line the refusal quotes: that
 * is where a version-manager shim says why it ran no bash.
 */
const BASH_PROBE_STDERR_CHARS = 300;

const POSIX_FIXED_LOCATIONS = ["/bin/bash", "/usr/bin/bash"];

/**
 * The configured bash, or `undefined` when the key is unset. Global scope only:
 * the value is an absolute path judged against `process.platform`, which no one
 * committed project value could suit on a mixed-OS team.
 */
function configuredBash(): string | undefined {
  return getConfigValueByKey(BASH_CONFIG_KEY) as string | undefined;
}

/**
 * Where bash comes from, first hit wins: `scripts.bash` from the global config
 * (an unusable value refuses the step rather than falling through), then `bash`
 * on the tool server's PATH, then fixed locations for an editor-spawned server
 * with a short login PATH. On Windows every candidate under `%SystemRoot%` is
 * skipped: `System32\bash.exe` is the WSL launcher, which runs the file in a
 * Linux distribution where the project path and `$ARGENT_OUTPUT` do not exist.
 */
export async function resolveBashInterpreter(
  probeEnv: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  probeCwd?: string
): Promise<{ path: string; note?: string } | { problem: string } | { cancelled: true }> {
  if (signal?.aborted) return { cancelled: true };
  // An unreadable config reads as an empty document, so `scripts.bash` would look
  // unset; remember why, to say so in the result.
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

  // Kept so the final message names what was refused rather than saying to install bash.
  const rejected: string[] = [];
  for (const candidate of await bashSearchPath()) {
    const shape = interpreterProblem(candidate);
    if (shape) {
      // Only about a file that is really there; the WSL launcher is named by the message.
      if (!shape.startsWith("is the WSL launcher") && fileExists(candidate)) {
        rejected.push(`${candidate} ${shape}`);
      }
      continue;
    }
    const problem = await notBashProblem(candidate, probeEnv, signal, probeCwd);
    if (signal?.aborted) return { cancelled: true };
    if (!problem) {
      // Say what was refused first, or the step never mentions it.
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

/**
 * Whether the candidate is really a bash, asked by running it. A wrong program
 * would pass invisibly: the seeded `$ARGENT_OUTPUT` document is accepted and exit
 * 0 is a pass, e.g. a wrapper that forgets to forward its arguments. Checks
 * `BASH_VERSION` rather than the exit status, which zsh, ksh and dash leave empty.
 */
async function notBashProblem(
  candidate: string,
  probeEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  cwd?: string
): Promise<string | null> {
  const answer = await askForBashVersion(candidate, probeEnv, signal, cwd);
  if (answer.answered) return null;
  if (answer.signal) {
    // Tell a candidate this check stopped (slow or hanging) from one that died of
    // a signal nothing here sent: the remedies differ.
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
 * One run of the candidate, bounded on every axis, since this is the only place
 * a `.sh` step waits before it has a process to time out: stdin is the null
 * device, stdout is read a line at a time keeping only the answer, a candidate
 * alive at the timeout is stopped and then killed, and the answer is taken at
 * the candidate's own exit rather than at the close of a pipe its children hold.
 */
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
        // The step's environment, not the tool server's: `BASH_ENV` is outside the
        // step allowlist, and the candidate must not get the token and secrets.
        env: probeEnv,
        // The step's directory: a version-manager shim picks its bash from it.
        cwd,
        // stderr for the refusal to quote: a shim says there why it ran no bash.
        stdio: ["ignore", "pipe", "pipe"],
        // A group of its own on POSIX, so the stops below also reach what the
        // candidate started. Windows has no group.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      resolve({ answered: false, signal: null, stoppedByCheck: false, failure: firstLine(err) });
      return;
    }
    // Only the unfinished last line is kept, never the whole output.
    let pending = "";
    let answered = false;
    // The head of the first non-blank stderr line, and of the line still arriving.
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
      // Nothing waits for a still-running candidate, so release its pipes and handle.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      // A last line without a trailing newline is still in `pending`.
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
    // A cancelled request stops the lookup instead of waiting out every candidate.
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
      // The HEAD of an unfinished line, because that is where a marker starts.
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
    // Answered at exit once stdout has ended with the marker; `close` also waits
    // for stderr, which a background job can hold. Without a marker the refusal
    // quotes stderr, so it waits for `close` or the settle.
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

/** The candidate's group first (what a shim started), then the candidate alone. */
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

/**
 * The ordered candidates tried when `scripts.bash` is unset, before any is checked
 * against the filesystem. Exported so the Windows rules can be tested on POSIX.
 */
export async function bashSearchPath(): Promise<string[]> {
  const onPath = await commandOnPath("bash", isUsableCandidate);
  return withoutRepeats([...(onPath ? [onPath] : []), ...(await fixedLocations())]);
}

/** One entry per file (case-insensitive on Windows), so none is probed twice. */
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
 * uses. Absolute because `spawn` would resolve a relative path against the
 * runner's own cwd; on Windows `X_OK` succeeds for any file, so existence is the
 * whole check. The shape rules match what `argent config set scripts.bash`
 * applies; the filesystem checks run here because the file may have changed since.
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

/** win32 semantics under win32 whatever the host, so the rules are testable on POSIX. */
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
 * Every name Windows gives the same file: with and without the `\\?\` prefix, and
 * the `realpath.native` answer for an 8.3 short name such as `C:\PROGRA~1\…`.
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
 * Git for Windows in the shapes its installers produce: derived from `git.exe` on
 * PATH (a per-user install), the `Program Files` locations (Chocolatey included),
 * and Scoop's two roots, since a Scoop shim has no `bin\bash.exe` beside it.
 */
async function fixedLocations(): Promise<string[]> {
  if (process.platform !== "win32") return POSIX_FIXED_LOCATIONS;
  const candidates: string[] = [];
  const git = await commandOnPath("git");
  if (git && pathWin32.isAbsolute(git)) {
    // `<Git>\cmd\git.exe` and `<Git>\bin\git.exe` sit two levels above
    // `<Git>\bin\bash.exe`, `<Git>\mingw64\bin\git.exe` three; both are offered.
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
