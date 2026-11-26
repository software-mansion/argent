import pc from "picocolors";

// A clack prompt on exhausted stdin never settles, and the command exits 0 having done nothing.
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
