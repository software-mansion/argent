import { execSync as nodeExecSync, type ExecSyncOptions } from "child_process";

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/**
 * `xctrace export` floods stderr with multi-megabyte progress/symbolication
 * noise (observed ~4.4 MB for a single `--toc` on a 122 MB trace). Node's
 * default `maxBuffer` is only 1 MiB, so spawnSync throws `ENOBUFS` on every
 * export command before xctrace ever evaluates the xpath — which previously
 * masqueraded as a "schema not found" failure. 256 MiB gives ample headroom.
 */
export const DEFAULT_EXEC_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Wrapper around execSync that always supplies a timeout. A misbehaving
 * `xctrace export`, `xctrace version`, or shelled-out helper would otherwise
 * block the Node event loop indefinitely.
 */
export function execSyncWithTimeout(
  command: string,
  options: ExecSyncOptions & { timeout?: number } = {}
): Buffer | string {
  return nodeExecSync(command, {
    timeout: DEFAULT_EXEC_TIMEOUT_MS,
    maxBuffer: DEFAULT_EXEC_MAX_BUFFER,
    ...options,
  });
}
