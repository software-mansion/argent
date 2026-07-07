import { execFileSync, spawn } from "node:child_process";
import type { ShellCommand } from "./package-manager.js";

export interface TrustDiskOutcome {
  /** The caller's on-disk probe found the desired outcome. */
  landed: boolean;
  /** The command's non-zero-exit error, or null when it exited cleanly. */
  exitError: Error | null;
}

// Run a package-manager command whose exit code can lie, and decide success
// from the disk instead: pnpm 10+ exits non-zero (ERR_PNPM_IGNORED_BUILDS)
// when it blocks a dependency's postinstall scripts even though the package
// installed fine, and argent works without those scripts. A non-zero exit is
// captured (never thrown); callers branch on `landed` — typically fatal only
// when `!landed`, a dim warning when both are set.
export async function runTrustingDisk(
  execute: () => void | Promise<void>,
  landedOnDisk: () => boolean
): Promise<TrustDiskOutcome> {
  let exitError: Error | null = null;
  try {
    await execute();
  } catch (err) {
    exitError = err instanceof Error ? err : new Error(String(err));
  }
  return { landed: landedOnDisk(), exitError };
}

// Synchronous package-manager run with inherited stdio, for interactive flows
// where the user should see the package manager's own output. On Windows the
// BARE bin name runs through a shell: npm-installed managers are .cmd shims
// Node (post-CVE-2024-27980) refuses to spawn shell-less, while bun/pnpm from
// native installers are real .exe files — cmd.exe's PATHEXT resolves both,
// where a hardcoded `.cmd` suffix would break the .exe-based managers.
// Throws the execFileSync error on non-zero exit.
export function execShellCommandSync(
  cmd: ShellCommand,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): void {
  execFileSync(cmd.bin, cmd.args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
}

// Run a package-manager command, capturing stderr for the rejection message.
// Windows handling mirrors execShellCommandSync: the BARE bin name through a
// shell, so PATHEXT resolves both .cmd shims (npm/yarn) and native .exe
// managers (bun, standalone pnpm) — a hardcoded `.cmd` suffix breaks the
// latter. Local-install commands require `opts.cwd` so they mutate the
// project's manifest, not whatever cwd argent runs in.
export function runShellCommand(cmd: ShellCommand, opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.bin, cmd.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Command exited with code ${code}`));
    });

    child.on("error", reject);
  });
}
