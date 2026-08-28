import { execFileSync, spawn } from "node:child_process";
import type { ShellCommand } from "./package-manager.js";

interface TrustDiskOutcome {
  /** The caller's on-disk probe found the desired outcome. */
  landed: boolean;
  exitError: Error | null;
}

// Decide a package-manager command's success from the disk, not its exit code:
// pnpm 10+ exits non-zero (ERR_PNPM_IGNORED_BUILDS) when it blocks a
// dependency's build scripts, which argent does not need. The error is captured
// rather than thrown, so callers branch on `landed`.
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

// Inherited stdio, so the user sees the package manager's own output. On
// Windows the BARE bin name runs through a shell: Node refuses to spawn
// npm-installed .cmd shims shell-less (post-CVE-2024-27980), and cmd.exe's
// PATHEXT also resolves native .exe managers (bun, standalone pnpm) that a
// hardcoded `.cmd` suffix would break. Throws on non-zero exit.
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

// Carries the exit code and signal because the message alone can't be
// classified: cmd.exe's "is not recognized" text is localized (exit code 9009
// is its locale-independent equivalent), and a signal-terminated child closes
// with `code null` — an interrupted install must not be retried.
export class ShellCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null
  ) {
    super(message);
    this.name = "ShellCommandError";
  }
}

// Captures stderr for the rejection message; Windows shell handling mirrors
// execShellCommandSync. Local-install commands must pass `opts.cwd` so they
// mutate the project's manifest, not whatever cwd argent runs in.
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

    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new ShellCommandError(
            stderr.trim() ||
              (signal !== null
                ? `Command terminated by signal ${signal}`
                : `Command exited with code ${code}`),
            code,
            signal
          )
        );
    });

    child.on("error", reject);
  });
}
