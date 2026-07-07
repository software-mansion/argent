/**
 * Help handling for the installer subcommands (init / install / update /
 * uninstall / remove).
 *
 * These commands forward their argv straight to the side-effecting installer
 * functions, which do not themselves short-circuit on `--help`. Without an
 * explicit guard `argent uninstall --help` runs the real uninstall — it even
 * opens the destructive "Remove argent configuration from this workspace?"
 * prompt. The dispatcher checks `installerHelpRequested` before dispatching so
 * a help request prints usage and returns without loading or invoking any
 * installer code.
 *
 * The other subcommands (run / tools / server / link / flags / …) handle
 * `--help` themselves, so they are deliberately excluded here — intercepting
 * them would swallow their own command-specific help.
 *
 * This module is also the single source of truth for each installer command's
 * one-line summary: the top-level `argent --help` table in cli.ts reads it from
 * `INSTALLER_COMMAND_META` so the two can't drift.
 */

/** Installer subcommands that lack their own `--help` handling. */
export const INSTALLER_COMMANDS = ["init", "install", "update", "uninstall", "remove"] as const;

export type InstallerCommand = (typeof INSTALLER_COMMANDS)[number];

export function isInstallerCommand(command: string | undefined): command is InstallerCommand {
  return INSTALLER_COMMANDS.includes(command as InstallerCommand);
}

/**
 * True when `arg` is an unambiguous help flag. Matched leniently — these guard
 * destructive installer commands, so a fat-fingered `--help=foo` or an
 * upper-case `--HELP` must still short-circuit to usage rather than fall
 * through to the real (config-deleting) command.
 */
function isHelpFlag(arg: string): boolean {
  const lower = arg.toLowerCase();
  return lower === "--help" || lower === "-h" || lower.startsWith("--help=");
}

/**
 * True when `command` is an installer subcommand and `rest` requests help. Pure
 * — the dispatcher uses it to short-circuit before running any side-effecting
 * installer code.
 *
 * Help is recognised from a help flag anywhere in `rest` (`--help`, `-h`,
 * `--help=…`, case-insensitively) or the bareword `help` as the first argument
 * (`argent uninstall help`). The bareword is only honoured in first position so
 * a flag value such as `--from help` isn't mistaken for a help request.
 */
export function installerHelpRequested(command: string | undefined, rest: string[]): boolean {
  if (!isInstallerCommand(command)) return false;
  if (rest.some(isHelpFlag)) return true;
  return rest[0]?.toLowerCase() === "help";
}

interface InstallerOption {
  /** Flag spelling as shown to the user, e.g. `--from <path>` or `--yes, -y`. */
  flag: string;
  description: string;
}

interface InstallerCommandMeta {
  /**
   * One-line summary shared with the top-level `argent --help` table. No
   * trailing period — cli.ts renders it inline in a command list, and
   * `printInstallerHelp` appends its own.
   */
  summary: string;
  /** Usage line, e.g. `argent init [options]`. */
  usage: string;
  /** Real flags this command parses. Empty for aliases (see `aliasOf`). */
  options: InstallerOption[];
  /** When set, this command is an alias; its help defers to the target's. */
  aliasOf?: InstallerCommand;
}

const NON_INTERACTIVE_OPTION: InstallerOption = {
  flag: "--yes, -y",
  description: "Run without prompts, accepting defaults.",
};
const NO_TELEMETRY_OPTION: InstallerOption = {
  flag: "--no-telemetry",
  description: "Opt out of anonymous telemetry for this run.",
};

/**
 * How each installer subcommand is described in help — its summary (the sole
 * copy, also rendered by the top-level table in cli.ts), usage, and options.
 * The option lists are hand-maintained to mirror the flags each installer
 * actually parses (see packages/argent-installer/src/{init,update,uninstall}.ts);
 * keep them in sync when those flags change — nothing links them automatically.
 */
export const INSTALLER_COMMAND_META: Record<InstallerCommand, InstallerCommandMeta> = {
  init: {
    summary: "Initialize argent in the current workspace (MCP server + skills + rules)",
    usage: "argent init [options]",
    options: [
      NON_INTERACTIVE_OPTION,
      NO_TELEMETRY_OPTION,
      {
        flag: "--from <path>",
        description: "Install from a local tarball or package spec instead of the npm release.",
      },
    ],
  },
  install: {
    summary: "Alias for init",
    usage: "argent install [options]",
    options: [],
    aliasOf: "init",
  },
  update: {
    summary: "Check for updates and refresh configuration",
    usage: "argent update [options]",
    options: [
      NON_INTERACTIVE_OPTION,
      NO_TELEMETRY_OPTION,
      {
        flag: "--version <version>",
        description: "Update to a specific version instead of the latest.",
      },
    ],
  },
  uninstall: {
    summary: "Remove argent configuration from the current workspace",
    usage: "argent uninstall [options]",
    options: [{ flag: "--yes, -y", description: "Skip the confirmation prompt." }],
  },
  remove: {
    summary: "Alias for uninstall",
    usage: "argent remove [options]",
    options: [],
    aliasOf: "uninstall",
  },
};

/**
 * Print the usage block for an installer subcommand — usage line, summary, the
 * command's options (or a pointer to the aliased command), and a footer.
 * Read-only: no network, no wizard, no prompt.
 */
export function printInstallerHelp(command: InstallerCommand): void {
  const meta = INSTALLER_COMMAND_META[command];
  const lines: string[] = ["", `Usage: ${meta.usage}`, "", `${meta.summary}.`];

  if (meta.aliasOf) {
    lines.push("", `Run \`argent ${meta.aliasOf} --help\` to see its options.`);
  } else if (meta.options.length > 0) {
    const width = Math.max(...meta.options.map((o) => o.flag.length));
    lines.push("", "Options:");
    for (const option of meta.options) {
      lines.push(`  ${option.flag.padEnd(width)}  ${option.description}`);
    }
  }

  lines.push("", "Run `argent --help` for the full list of commands.", "");
  console.log(lines.join("\n"));
}
