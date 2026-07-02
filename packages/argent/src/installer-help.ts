/**
 * Help handling for the installer subcommands (init / install / update /
 * uninstall / remove).
 *
 * These commands forward their argv straight to the side-effecting installer
 * functions, which do not themselves short-circuit on `--help`. Without an
 * explicit guard `argent uninstall --help` runs the real uninstall — it even
 * opens the destructive "Remove argent configuration from this workspace?"
 * prompt. The dispatcher checks `installerHelpRequested` before dispatching so
 * `--help`/`-h` prints usage and returns without loading or invoking any
 * installer code.
 *
 * The other subcommands (run / tools / server / link / flags / …) handle
 * `--help` themselves, so they are deliberately excluded here — intercepting
 * them would swallow their own command-specific help.
 */

/** Installer subcommands that lack their own `--help` handling. */
export const INSTALLER_COMMANDS = ["init", "install", "update", "uninstall", "remove"] as const;

export type InstallerCommand = (typeof INSTALLER_COMMANDS)[number];

export function isInstallerCommand(command: string | undefined): command is InstallerCommand {
  return INSTALLER_COMMANDS.includes(command as InstallerCommand);
}

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

/**
 * True when `command` is an installer subcommand and `rest` requests help
 * (`--help` or `-h`). Pure — the dispatcher uses it to short-circuit before
 * running any side-effecting installer code.
 */
export function installerHelpRequested(command: string | undefined, rest: string[]): boolean {
  return isInstallerCommand(command) && rest.some(isHelpFlag);
}

/** One-line usage + description for each installer subcommand. */
const INSTALLER_USAGE: Record<InstallerCommand, { usage: string; description: string }> = {
  init: {
    usage: "argent init [options]",
    description: "Initialize argent in the current workspace (MCP server + skills + rules).",
  },
  install: {
    usage: "argent install [options]",
    description: "Alias for `argent init`.",
  },
  update: {
    usage: "argent update [options]",
    description: "Check for updates and refresh configuration.",
  },
  uninstall: {
    usage: "argent uninstall [options]",
    description: "Remove argent configuration from the current workspace.",
  },
  remove: {
    usage: "argent remove [options]",
    description: "Alias for `argent uninstall`.",
  },
};

/**
 * Print the short usage block for an installer subcommand. Read-only: no
 * network, no wizard, no prompt.
 */
export function printInstallerHelp(command: InstallerCommand): void {
  const { usage, description } = INSTALLER_USAGE[command];
  console.log(`
Usage: ${usage}

${description}

Run \`argent --help\` for the full list of commands.
`);
}
