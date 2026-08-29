/**
 * Help for the subcommands that cannot serve `--help` themselves (see
 * `INSTALLER_COMMANDS`), and the single source of truth for their help text:
 * the top-level `argent --help` table in cli.ts renders the summary and detail
 * lines from `INSTALLER_COMMAND_META`, so the two can't drift.
 */

/**
 * Subcommands whose argv never reaches a `--help` handler. The installers
 * forward theirs to side-effecting functions that ignore it, so `argent
 * uninstall --help` would run the real uninstall, destructive prompt included;
 * `mcp` is handed no argv at all — `startMcpServer` takes only its paths — so a
 * help flag there starts the stdio server and blocks reading JSON-RPC from
 * stdin. Every other subcommand parses `--help` itself.
 */
export const INSTALLER_COMMANDS = [
  "init",
  "install",
  "update",
  "uninstall",
  "remove",
  "mcp",
] as const;

export type InstallerCommand = (typeof INSTALLER_COMMANDS)[number];

export function isInstallerCommand(command: string | undefined): command is InstallerCommand {
  return INSTALLER_COMMANDS.includes(command as InstallerCommand);
}

/**
 * True when `arg` is a help flag: `--help`, `-h`, `--help=<anything>`,
 * single-dash `-help`, or em/en-dash `—help` (smart-dash editors rewrite a
 * pasted `--` into one), all case-insensitive. Anything else — `/help`,
 * `--helpme` — falls through to the real command, where uninstall's
 * confirmation still guards the destructive path unless `--yes` was passed.
 */
function isHelpFlag(arg: string): boolean {
  const lower = arg.toLowerCase().replace(/^[—–]/, "--");
  return lower === "--help" || lower === "-h" || lower === "-help" || lower.startsWith("--help=");
}

/**
 * Flags that consume the next argv token, mirroring the real parsers: a
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
  // `mcp` parses nothing, so a bareword `help` in any position is a help request.
  mcp: [],
};

/**
 * True when `command` is an installer subcommand and `rest` requests help.
 * Pure, so the dispatcher can short-circuit before loading installer code.
 *
 * Matches a help flag anywhere in `rest` (see `isHelpFlag`), or the bareword
 * `help` (case-insensitive) in any position EXCEPT directly after a
 * value-taking flag, where it is that flag's value: `argent init --from help`
 * names a package literally called `help`. The bareword matters on the
 * destructive path — `argent uninstall --yes help` would otherwise run a
 * prompt-free uninstall (`--yes` skips the confirmation).
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
   * `printInstallerHelp` appends one.
   */
  summary: string;
  /**
   * Extra lines rendered indented under the summary in the top-level command
   * table (cli.ts) only; per-command `--help` conveys the same through its
   * option descriptions.
   */
  details?: string[];
  /**
   * Prose rendered under the summary in this command's own `--help` only — the
   * mirror of `details`. For what the option list cannot carry.
   */
  notes?: string[];
  /** Usage line, e.g. `argent init [options]`. */
  usage: string;
  /** Flags listed in this command's help. Empty for aliases (see `aliasOf`). */
  options: InstallerOption[];
  /** When set, this command is an alias; its help defers to the target's. */
  aliasOf?: InstallerCommand;
}

const NON_INTERACTIVE_OPTION: InstallerOption = {
  flag: "--yes, -y",
  description: "Run without prompts, accepting defaults. Required with no terminal on stdin.",
};
const NO_TELEMETRY_OPTION: InstallerOption = {
  flag: "--no-telemetry",
  description: "Opt out of anonymous telemetry for this run.",
};

/**
 * Help copy per subcommand. The summary and detail lines are the sole copy, also
 * rendered by the top-level table in cli.ts. The option lists mirror the flags
 * the installers parse (init-args.ts, update.ts, uninstall.ts,
 * install-targets.ts in packages/argent-installer);
 * test/installer-flags-sync.test.ts fails when they drift.
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
      {
        flag: "--yes, -y",
        description: "Skip the confirmation prompt. Required with no terminal on stdin.",
      },
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
  mcp: {
    summary: "Start the MCP stdio server (used by editors)",
    usage: "argent mcp",
    notes: [
      "Speaks the Model Context Protocol over stdio: JSON-RPC requests on stdin,",
      "responses on stdout. Editors launch it themselves — `argent init` writes the",
      "`argent mcp` entry into the editor's MCP config — and start one server per",
      "session. Run by hand it waits for JSON-RPC on stdin and looks like it has",
      "hung; Ctrl-C to quit.",
      "",
      "It takes no options and owns stdout, so diagnostics go to stderr. Calls are",
      "logged to ~/.argent/mcp-calls.log (override with ARGENT_MCP_LOG). Tools are",
      "served by the argent tool-server, spawned on demand unless ARGENT_TOOLS_URL",
      "or `argent link` points at one already running.",
      "",
      "To drive the same tools from a terminal, use `argent tools` and",
      "`argent run <tool>`.",
    ],
    options: [{ flag: "--help, -h", description: "Show this help." }],
  },
};

/**
 * Print a subcommand's usage block. Read-only: no network, no wizard, no
 * prompt.
 */
export function printInstallerHelp(command: InstallerCommand): void {
  const meta = INSTALLER_COMMAND_META[command];
  const lines: string[] = ["", `Usage: ${meta.usage}`, "", `${meta.summary}.`];

  if (meta.notes) lines.push("", ...meta.notes);

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
