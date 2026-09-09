import pc from "picocolors";

// clack reads keystrokes straight from stdin. Answers piped in do settle its
// prompts, but the moment that input runs out — a closed descriptor, or a
// script that supplied fewer answers than were asked — the promise never
// settles: the command unwinds through no branch at all and exits 0 having
// done nothing. Off a terminal there is no way to know an answer will arrive,
// so a command that has to ask refuses instead of gambling on one.
export function canPromptUser(): boolean {
  return process.stdin.isTTY === true;
}

// `remedy` completes "Re-run with --yes …": --yes is not the same choice at
// every command, so each site says what taking it will do.
export function noTerminalMessage(command: string, remedy: string): string {
  return (
    `${command} has a question to ask and there is no terminal on stdin to answer it.\n\n` +
    `  Re-run with ${pc.cyan("--yes")} ${remedy}`
  );
}
