import { exec as nodeExec, type ExecOptions } from "child_process";
import { promisify } from "util";

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/**
 * `xctrace export` floods stderr with multi-megabyte progress/symbolication
 * noise (observed ~4.4 MB for a single `--toc` on a 122 MB trace, and far more
 * for a host-wide `--all-processes` capture). Node's default `maxBuffer` is
 * only 1 MiB, so the export command throws `ENOBUFS` before xctrace ever
 * evaluates the xpath — which previously masqueraded as a "schema not found"
 * failure. 256 MiB gives ample headroom.
 */
export const DEFAULT_EXEC_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Async wrapper around `exec` that always supplies a timeout and a generous
 * `maxBuffer`.
 *
 * This MUST stay async (`exec` + `await`), never `execSync`. A single
 * `native-profiler-stop` runs four `xctrace export` passes (TOC discovery, CPU,
 * hangs, leaks); under the host-wide `--all-processes` capture each pass exports
 * tens of MB and the whole stop takes ~30s+. With `execSync` that work freezes
 * the tool-server's event loop for the full duration, so its `/tools` health
 * endpoint stops answering. The MCP client treats a health check that misses
 * its 2s window as a dead server, respawns a replacement tool-server, and
 * rotates the auth token — which 401s the very stop request that was about to
 * succeed. Keeping the export non-blocking leaves the event loop free to answer
 * health checks while xctrace runs.
 *
 * The `timeout` still caps a genuinely-stuck `xctrace` so it cannot hang the
 * stop forever; with async exec that timeout no longer also pins the event loop.
 */
export async function execAsyncWithTimeout(
  command: string,
  options: ExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  // `promisify` is resolved per-call (not at module load) so that test suites
  // which `vi.doMock("child_process", …)` without an `exec` export can still
  // import this module — matching the original lazy `execSync` usage.
  const execAsync = promisify(nodeExec);
  const { stdout, stderr } = await execAsync(command, {
    timeout: DEFAULT_EXEC_TIMEOUT_MS,
    maxBuffer: DEFAULT_EXEC_MAX_BUFFER,
    encoding: "utf-8",
    ...options,
  });
  return { stdout: stdout as string, stderr: stderr as string };
}
