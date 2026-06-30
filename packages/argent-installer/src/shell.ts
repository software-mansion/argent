import { spawn } from "node:child_process";
import type { ShellCommand } from "./package-manager.js";

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
