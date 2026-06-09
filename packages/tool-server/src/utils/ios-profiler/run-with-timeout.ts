import { execSync as nodeExecSync, type ExecSyncOptions } from "child_process";

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

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
    ...options,
  });
}
