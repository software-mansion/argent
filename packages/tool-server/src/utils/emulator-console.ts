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
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const verdict = lines[lines.length - 1];
  if (verdict?.startsWith("KO:")) {
    throw new Error(`emulator console rejected \`${args.join(" ")}\` — ${verdict}`);
  }
  return stdout;
}
