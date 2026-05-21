import { spawn } from "node:child_process";
import type { ShellCommand } from "./package-manager.js";

// Run a ShellCommand to completion and reject with its stderr on
// non-zero exit. Used by the install/update spinners — stdout/stderr are
// piped (not inherited) so they don't fight with @clack/prompts.
export function runShellCommand(cmd: ShellCommand, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? `${cmd.bin}.cmd` : cmd.bin, cmd.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
      ...(cwd ? { cwd } : {}),
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
