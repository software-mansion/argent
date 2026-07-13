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
 * help text: the top-level `argent --help` table in cli.ts reads the summary
 * and detail lines from `INSTALLER_COMMAND_META` so the two can't drift.
 */

/** Installer subcommands that lack their own `--help` handling. */
export const INSTALLER_COMMANDS = ["init", "install", "update", "uninstall", "remove"] as const;

export type InstallerCommand = (typeof INSTALLER_COMMANDS)[number];

export function isInstallerCommand(command: string | undefined): command is InstallerCommand {
  return INSTALLER_COMMANDS.includes(command as InstallerCommand);
}

/**
 * True when `arg` is a help flag. Accepted spellings, all case-insensitive:
 * `--help`, `-h`, `--help=<anything>`, single-dash `-help`, and an em/en-dash
 * `—help` (smart-dash editors rewrite a pasted `--` into one). Anything else —
 * e.g. `/help` or `--helpme` — is NOT treated as help and falls through to the
 * real command, where uninstall's interactive confirmation still guards the
 * destructive path (unless `--yes` was also passed).
 */
function isHelpFlag(arg: string): boolean {
  // Smart-dash normalization: a leading em/en dash stands for the `--` it was
  // rewritten from.
  const lower = arg.toLowerCase().replace(/^[—–]/, "--");
  return lower === "--help" || lower === "-h" || lower === "-help" || lower.startsWith("--help=");
}

/**
 * Flags that consume the next argv token, mirroring the real parsers
 * (`extractFlag` in init-args.ts, the lookahead loops in update.ts). A
 * bareword `help` immediately after one of these is that flag's value, not a
 * help request. `--project-root` (update) is agent-internal — parsed but
 * deliberately absent from the help text. Kept in sync with the parsers by
 * test/installer-flags-sync.test.ts.
 */
export const VALUE_TAKING_FLAGS: Record<InstallerCommand, readonly string[]> = {
  init: ["--from"],
  install: ["--from"],
  update: ["--version", "--project-root"],
  uninstall: [],
  remove: [],
};

/**
 * True when `command` is an installer subcommand and `rest` requests help. Pure
 * — the dispatcher uses it to short-circuit before running any side-effecting
 * installer code.
 *
 * Help is recognised from a help flag anywhere in `rest` (see `isHelpFlag`) or
 * the bareword `help` (case-insensitive) in any position — EXCEPT directly
 * after a value-taking flag, where it is that flag's value: `argent init
 * --from help` names a package literally called `help` and must reach the
 * installer. The bareword matters on the destructive path: `argent uninstall
 * --yes help` would otherwise run a prompt-free uninstall (`--yes` skips the
 * confirmation).
 */
export function installerHelpRequested(command: string | undefined, rest: string[]): boolean {
  if (!isInstallerCommand(command)) return false;
  if (rest.some(isHelpFlag)) return true;
  const valueFlags = VALUE_TAKING_FLAGS[command];
  return rest.some(
    (arg, i) => arg.toLowerCase() === "help" && (i === 0 || !valueFlags.includes(rest[i - 1]!))
  );
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
  /**
   * Extra lines rendered indented under the summary in the top-level command
   * table (cli.ts). Per-command `--help` conveys the same information through
   * the option descriptions instead.
   */
  details?: string[];
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
 * How each installer subcommand is described in help — its summary and detail
 * lines (the sole copy, also rendered by the top-level table in cli.ts), usage,
 * and options. The option lists mirror the flags each installer actually parses
 * (init-args.ts, update.ts, uninstall.ts, install-targets.ts in
 * packages/argent-installer); test/installer-flags-sync.test.ts fails when they
 * drift from the parsers.
 */
export const INSTALLER_COMMAND_META: Record<InstallerCommand, InstallerCommandMeta> = {
  init: {
    summary: "Initialize argent in the current workspace (MCP server + skills + rules)",
    details: [
      "(--global [default] installs on PATH; --local commits a",
      "devDependency setup the whole team gets on `npm install`)",
    ],
    usage: "argent init [options]",
    options: [
      NON_INTERACTIVE_OPTION,
      NO_TELEMETRY_OPTION,
      {
        flag: "--from <path>",
        description: "Install from a local tarball or package spec instead of the npm release.",
      },
      {
        flag: "--global",
        description: "Install on PATH for this machine (the default).",
      },
      {
        flag: "--local",
        description: "Commit a devDependency setup the whole team gets on `npm install`.",
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
    details: [
      "(acts on the present install — both when a global install and a",
      "project devDependency coexist; --global/--local select explicitly)",
    ],
    usage: "argent update [options]",
    options: [
      NON_INTERACTIVE_OPTION,
      NO_TELEMETRY_OPTION,
      {
        flag: "--version <version>",
        description: "Update to a specific version instead of the latest.",
      },
      {
        flag: "--global",
        description: "Act on the global (PATH) install when both kinds coexist.",
      },
      {
        flag: "--local",
        description: "Act on the project-local (devDependency) install when both kinds coexist.",
      },
    ],
  },
  uninstall: {
    summary: "Remove argent configuration from the current workspace",
    details: ["(--global/--local choose which install — package and its", "configs — is removed)"],
    usage: "argent uninstall [options]",
    options: [
      { flag: "--yes, -y", description: "Skip the confirmation prompt." },
      {
        flag: "--global",
        description: "Remove the global (PATH) install — the package and its configs.",
      },
      {
        flag: "--local",
        description:
          "Remove the project-local (devDependency) install — the package and its configs.",
      },
    ],
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
