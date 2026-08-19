import pc from "picocolors";

// clack reads keystrokes straight from stdin: behind a pipe or a closed
// descriptor its promise never settles, so a command that asks anyway unwinds
// through no branch at all and exits 0 having done nothing.
export function canPromptUser(): boolean {
  return process.stdin.isTTY === true;
}

export function noTerminalMessage(command: string): string {
  return (
    `${command} has a question to ask and stdin is not a terminal, so no answer can reach it.\n\n` +
    `  Re-run with ${pc.cyan("--yes")} to take the defaults without being asked.`
  );
}
