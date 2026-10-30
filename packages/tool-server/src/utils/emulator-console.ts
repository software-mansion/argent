import { homedir } from "node:os";
import { join } from "node:path";
import { runAdb } from "./adb";

/**
 * Run an emulator-console command, failing when the console rejects it.
 *
 * `adb emu` exits 0 even on refusal — the only sign is a `KO:` line in the reply,
 * so `runAdb`, which inspects the exit code alone, reads a rejected command as a
 * successful one.
 *
 * Only the LAST non-empty line is the verdict: an unrelated `KO:` (an
 * authentication banner, say) can precede a command that then succeeds with `OK`.
 */
export async function runEmuConsole(serial: string, args: string[]): Promise<string> {
  const { stdout } = await runAdb(["-s", serial, "emu", ...args], { timeoutMs: 10_000 });
  const verdict = replyLines(stdout).at(-1);
  if (verdict?.startsWith("KO:")) {
    throw new Error(
      `emulator console rejected \`${args.join(" ")}\` — ${describeConsoleReply(stdout)}`
    );
  }
  return stdout;
}

/**
 * The whole `adb emu` reply on one line, for an error message.
 *
 * Before auth the console refuses every command as unknown, and adb skips auth
 * unless its token file is non-empty and, outside Windows, not a symlink (adb
 * opens it with O_NOFOLLOW, which Windows lacks), so that reply also names the file.
 */
export function describeConsoleReply(stdout: string): string {
  const lines = replyLines(stdout);
  const reply = lines.join("; ") || "empty reply";
  if (!lines.at(-1)?.startsWith("KO: unknown command")) return reply;
  const tokenFile = join(homedir(), ".emulator_console_auth_token");
  const fileKind = process.platform === "win32" ? "a file" : "a regular file, not a symlink,";
  return `${reply} (adb authenticates to the console with ${tokenFile}, which must be ${fileKind} holding the emulator's token)`;
}

function replyLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
