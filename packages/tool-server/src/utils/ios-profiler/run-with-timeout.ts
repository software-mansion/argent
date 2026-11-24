import { execFile as nodeExecFile, type ExecFileOptions } from "child_process";
import { promisify } from "util";

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/**
 * `xctrace export` writes multi-megabyte progress/symbolication noise to stderr,
 * so Node's default 1 MiB `maxBuffer` kills the export with `ENOBUFS` before
 * xctrace evaluates the xpath — which surfaced downstream as a bogus
 * "no CPU schema found" failure.
 */
export const DEFAULT_EXEC_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * `execFile` wrapper that always supplies a timeout and a generous `maxBuffer`.
 * Never use `exec`/`execSync` here: they build a `/bin/sh -c` string, so a value
 * like a trace-file path would be re-parsed by the shell.
 *
 * It must also stay async, never `execFileSync`. One `native-profiler-stop` runs
 * four `xctrace export` passes and takes ~30s+; a sync exec blocks the event loop
 * for that whole time, so `GET /tools` misses the client's 2s health-check
 * window, the client respawns the tool-server and rotates the auth token, and the
 * in-flight stop request 401s.
 */
export async function execFileAsyncWithTimeout(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const execFileAsync = promisify(nodeExecFile);
  const { stdout, stderr } = await execFileAsync(file, args as string[], {
    encoding: "utf-8",
    ...options,
    // Applied after ...options so a caller cannot weaken the guards; maxBuffer
    // is a floor, so a caller may still raise it for a larger capture.
    timeout: DEFAULT_EXEC_TIMEOUT_MS,
    maxBuffer: Math.max(options.maxBuffer ?? 0, DEFAULT_EXEC_MAX_BUFFER),
  });
  return { stdout: stdout as string, stderr: stderr as string };
}
