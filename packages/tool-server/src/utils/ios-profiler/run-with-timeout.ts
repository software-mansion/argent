import { execFileSync, type ExecFileSyncOptions } from "child_process";

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/**
 * Wrapper around execFileSync that always supplies a timeout and never goes
 * through a shell: the command and its arguments are passed as a discrete argv
 * array, so a value like a trace-file path can't be re-parsed by /bin/sh
 * (shell-injection). A misbehaving `xctrace export` / `xctrace version` would
 * otherwise block the Node event loop indefinitely, so the timeout is enforced
 * here rather than left to each call site.
 */
export function execFileWithTimeout(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptions & { timeout?: number } = {}
): Buffer | string {
  return execFileSync(file, args as string[], {
    timeout: DEFAULT_EXEC_TIMEOUT_MS,
    ...options,
  });
}
