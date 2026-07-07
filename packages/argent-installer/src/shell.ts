import { execFileSync, spawn } from "node:child_process";
import type { ShellCommand } from "./package-manager.js";

export interface TrustDiskOutcome {
  /** The caller's on-disk probe found the desired outcome. */
  landed: boolean;
  /** The command's non-zero-exit error, or null when it exited cleanly. */
  exitError: Error | null;
}

// Run a package-manager command whose exit code can lie, and decide success
// from the DISK instead. pnpm 10+ exits non-zero (ERR_PNPM_IGNORED_BUILDS)
// when it blocks a dependency's build/postinstall scripts even though the
// package installed fine — argent works without those scripts, so treating
// the exit code as authoritative would fail a perfectly good install. The
// single owner of that policy: a non-zero exit is captured (never thrown) and
// callers branch on `landed` — typically fatal only when `!landed`, and a
// dim "exited non-zero but installed — continuing" warning when both are set.
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

// Synchronous package-manager run with inherited stdio, for the interactive
// update/uninstall flows where the user should see the package manager's own
// output. On Windows the command runs through a shell with its BARE name:
// npm/yarn/pnpm installed via npm are .cmd shims, which Node
// (post-CVE-2024-27980) refuses to spawn without a shell — while bun or pnpm
// from their native installers are real .exe files with no .cmd shim at all.
// cmd.exe's PATHEXT resolution handles both, where hardcoding a `.cmd` suffix
// would break the .exe-based managers. Throws the execFileSync error on
// non-zero exit, like execFileSync itself.
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
// On Windows the bin is suffixed with `.cmd` and spawned through a shell so the
// npm/yarn/pnpm/bun wrappers resolve. `opts.cwd` is required for local-install
// commands, which must mutate the project's manifest rather than the cwd argent
// happens to run in.
export function runShellCommand(cmd: ShellCommand, opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? `${cmd.bin}.cmd` : cmd.bin, cmd.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
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
