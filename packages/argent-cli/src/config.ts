// The `argent config` CLI over the schema-driven config system in
// `@argent/configuration-core`. Registering a key in CONFIG_SCHEMA is enough to
// surface it here. Keys with a `manageCommand` (e.g. telemetry) stay read-only
// and point the user at that command.

import * as path from "node:path";
import pc from "picocolors";
import {
  CONFIG_SCHEMA,
  configDir,
  findProjectRoot,
  getConfigDefinition,
  getConfigValueByKey,
  getConfigValueAtScope,
  setConfigValue,
  unsetConfigValue,
  listConfig,
  coerceCliValue,
  UnknownConfigKeyError,
  ConfigScopeError,
  ConfigValidationError,
  ConfigManagedElsewhereError,
  type FlagScope,
  type ConfigEntryView,
} from "@argent/configuration-core";

export function config(argv: string[]): void {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printUsage();
    return;
  }

  const [sub, ...rest] = argv;
  switch (sub) {
    case "list":
      return cmdList(rest);
    case "get":
      return cmdGet(rest);
    case "set":
      return cmdSet(rest);
    case "unset":
      return cmdUnset(rest);
    default:
      console.error(`Error: unknown subcommand "config ${sub}". Try \`argent config --help\`.`);
      process.exit(2);
  }
}

function cmdList(argv: string[]): void {
  if (wantsHelp(argv)) {
    console.log(`Usage: argent config list [--json]

Show every recognized configuration value, its effective (merged) value, and
the raw value stored at each scope.`);
    return;
  }
  const json = argv.includes("--json");
  const entries = listConfig();

  if (json) {
    console.log(JSON.stringify({ config: entries }, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log("No configurations are defined.");
    return;
  }

  console.log("Configuration (project overrides global unless noted):\n");
  const maxKey = entries.reduce((m, e) => Math.max(m, e.key.length), 0);
  for (const e of entries) {
    const managed = e.manageCommand ? pc.dim(`  [managed by \`${e.manageCommand}\`]`) : "";
    console.log(`  ${e.key.padEnd(maxKey)}  ${formatValue(e.effective)}${managed}`);
    console.log(`  ${" ".repeat(maxKey)}  ${pc.dim(e.description)}`);
    console.log(`  ${" ".repeat(maxKey)}  ${pc.dim(scopeDetail(e))}`);
  }
}

function scopeDetail(e: ConfigEntryView): string {
  const parts: string[] = [`scopes: ${e.scopes.join(", ")}`];
  // The description alone can't say it: a list-valued key reads like a string one.
  if (e.expected) parts.push(`value: ${e.expected}${e.example ? `, e.g. ${e.example}` : ""}`);
  if (e.project !== undefined) parts.push(`project=${formatValuePlain(e.project)}`);
  if (e.global !== undefined) parts.push(`global=${formatValuePlain(e.global)}`);
  return parts.join("  ·  ");
}

function cmdGet(argv: string[]): void {
  if (wantsHelp(argv)) {
    console.log(`Usage: argent config get <key> [--scope global|project] [--json]

Print a configuration value. Without --scope, prints the effective value after
merging project and global. With --scope, prints only that scope's stored value.`);
    return;
  }
  const { positionals, scope, json } = parseArgs(argv);
  const key = positionals[0];
  if (!key) {
    console.error("Error: `argent config get` requires a <key>.");
    process.exit(2);
  }
  if (positionals.length > 1) {
    console.error(`Error: unexpected extra argument "${positionals[1]}".`);
    process.exit(2);
  }

  try {
    const value = scope ? getConfigValueAtScope(key, scope) : getConfigValueByKey(key);
    if (json) {
      console.log(
        JSON.stringify({ key, scope: scope ?? "effective", value: value ?? null }, null, 2)
      );
    } else if (value === undefined) {
      console.log("(unset)");
    } else {
      console.log(formatValuePlain(value));
    }
  } catch (err) {
    reportError(err);
  }
}

function cmdSet(argv: string[]): void {
  if (wantsHelp(argv)) {
    console.log(`Usage: argent config set <key> <value> [--scope global|project]

Set a configuration value. Default scope is global; pass --scope project to
write <project-root>/.argent/config.json. Booleans, numbers, and JSON arrays are
parsed (e.g. \`true\`, \`42\`, \`["a","b"]\`); anything else is stored as a string.`);
    return;
  }
  const { positionals, scope } = parseArgs(argv);
  const key = positionals[0];
  const rawValue = positionals[1];
  if (!key || rawValue === undefined) {
    console.error("Error: `argent config set` requires a <key> and a <value>.");
    process.exit(2);
  }
  if (positionals.length > 2) {
    console.error(`Error: unexpected extra argument "${positionals[2]}".`);
    process.exit(2);
  }

  const targetScope: FlagScope = scope ?? "global";
  const warning = degenerateProjectScopeWarning(targetScope);
  try {
    // Report the value as normalized on write (trimmed, blanks dropped), not the input.
    const stored = setConfigValue(key, coerceCliValue(rawValue), targetScope);
    if (warning) console.error(pc.yellow(warning));
    console.log(`Set ${pc.bold(key)} = ${formatValuePlain(stored)} (${scopeLabel(targetScope)}).`);
  } catch (err) {
    // Built here, not in reportError: only this frame knows the value and scope typed.
    reportError(err, () => suggestCorrectedSet(err, key, rawValue, scope));
  }
}

function cmdUnset(argv: string[]): void {
  if (wantsHelp(argv)) {
    console.log(`Usage: argent config unset <key> [--scope global|project]

Remove a configuration value at a scope (default global). Falls back to the
other scope / the default on the next read.`);
    return;
  }
  const { positionals, scope } = parseArgs(argv);
  const key = positionals[0];
  if (!key) {
    console.error("Error: `argent config unset` requires a <key>.");
    process.exit(2);
  }
  if (positionals.length > 1) {
    console.error(`Error: unexpected extra argument "${positionals[1]}".`);
    process.exit(2);
  }

  const targetScope: FlagScope = scope ?? "global";
  const warning = degenerateProjectScopeWarning(targetScope);
  try {
    const removed = unsetConfigValue(key, targetScope);
    if (removed && warning) console.error(pc.yellow(warning));
    console.log(
      removed
        ? `Unset ${pc.bold(key)} (${scopeLabel(targetScope)}).`
        : pc.dim(`${key} was not set at ${targetScope} scope.`)
    );
  } catch (err) {
    reportError(err);
  }
}

interface ParsedArgs {
  positionals: string[];
  scope: FlagScope | null;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let scope: FlagScope | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--json") {
      json = true;
      continue;
    }
    if (tok === "--scope") {
      scope = parseScope(argv[++i]);
      continue;
    }
    if (tok.startsWith("--scope=")) {
      scope = parseScope(tok.slice("--scope=".length));
      continue;
    }
    if (tok.startsWith("--")) {
      console.error(`Error: unknown flag "${tok}".`);
      process.exit(2);
    }
    positionals.push(tok);
  }
  return { positionals, scope, json };
}

function parseScope(raw: string | undefined): FlagScope {
  if (raw === "global" || raw === "project") return raw;
  console.error(`Error: --scope must be "global" or "project"${raw ? `, got "${raw}"` : ""}.`);
  process.exit(2);
}

function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/** Names the resolved root for `project`, so a write shows which directory it meant. */
function scopeLabel(scope: FlagScope): string {
  if (scope === "global") return "global";
  return `project: ${path.dirname(configDir("project"))}`;
}

/**
 * Warns when "project" resolves somewhere surprising: to the home directory
 * (`~/.argent` is itself a project marker, and there the project file IS the
 * global one), or to the bare cwd because no marker was found. Must run BEFORE
 * the write — a project-scope `set` creates `.argent` in the resolved root,
 * hiding the no-marker case afterwards.
 */
function degenerateProjectScopeWarning(scope: FlagScope): string | null {
  if (scope !== "project") return null;
  const projDir = configDir("project");
  if (path.resolve(projDir) === path.resolve(configDir("global"))) {
    return (
      `WARNING: no project found between ${process.cwd()} and your home directory — ` +
      `"project" scope resolved to the home directory, so this writes the GLOBAL ` +
      `config file (${path.join(projDir, "config.json")}).`
    );
  }
  if (findProjectRoot(process.cwd()) === null) {
    return (
      `WARNING: no project markers (.argent, .git, package.json) found above ` +
      `${process.cwd()} — treating it as the project root and creating ` +
      `${path.join(projDir, "config.json")}.`
    );
  }
  return null;
}

function formatValuePlain(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Colorized variant for the human list view. */
function formatValue(value: unknown): string {
  if (value === undefined) return pc.dim("(unset)");
  if (typeof value === "boolean" && process.stdout.isTTY) {
    return value ? pc.green("true") : pc.red("false");
  }
  return formatValuePlain(value);
}

/** Quote so a pasted suggestion stores what it shows: bare `~`/brackets are eaten by the shell. */
function quoteForShell(value: string): string {
  if (/^[A-Za-z0-9._/@:+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command the user probably meant, or null. Only offered for the one
 * mechanical case: a single item given where a list-valued key was expected.
 * Nothing is written on their behalf — the command is printed for them to run.
 */
function suggestCorrectedSet(
  err: unknown,
  key: string,
  rawValue: string,
  scope: FlagScope | null
): string | null {
  if (!(err instanceof ConfigValidationError)) return null;
  const def = getConfigDefinition(key);
  if (!def) return null;
  // A successful parse of the wrapped value is the confidence test.
  const wrapped = def.parse([rawValue]);
  if (wrapped === undefined) return null;
  const scopeFlag = scope ? ` --scope ${scope}` : "";
  return `argent config set ${key} ${quoteForShell(JSON.stringify([rawValue]))}${scopeFlag}`;
}

function reportError(err: unknown, suggest?: () => string | null): never {
  if (err instanceof ConfigManagedElsewhereError) {
    console.error(`Error: ${err.message} Use \`${err.command}\` instead.`);
  } else if (
    err instanceof UnknownConfigKeyError ||
    err instanceof ConfigScopeError ||
    err instanceof ConfigValidationError
  ) {
    console.error(`Error: ${err.message}`);
    if (err instanceof UnknownConfigKeyError) {
      console.error(`Run \`argent config list\` to see available keys.`);
    }
    if (err instanceof ConfigValidationError) {
      const corrected = suggest?.() ?? null;
      if (corrected) {
        console.error(`Did you mean: ${corrected}`);
      } else if (err.example) {
        console.error(`Example: argent config set ${err.key} ${quoteForShell(err.example)}`);
      }
      console.error(`Run \`argent config list\` to see each key's expected value.`);
    }
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(2);
}

function printUsage(): void {
  const keys = CONFIG_SCHEMA.map((d) => d.key);
  const maxKey = keys.reduce((m, k) => Math.max(m, k.length), 0);
  const keyLines = CONFIG_SCHEMA.map((d) => {
    const managed = d.manageCommand ? pc.dim(` [managed by \`${d.manageCommand}\`]`) : "";
    return `  ${d.key.padEnd(maxKey)}  ${d.description}${managed}`;
  });

  console.log(`Usage: argent config <command> [options]

Manage argent configuration. Values are stored at two scopes and merged per the
configuration's policy:
  ~/.argent/config.json                 (global, default)
  <project-root>/.argent/config.json    (project, with --scope project)

Commands:
  list                 Show all configurations and their values
  get <key>            Print a value (effective, or --scope <scope>)
  set <key> <value>    Set a value (--scope global|project, default global)
  unset <key>          Remove a value at a scope (default global)

Recognized keys:
${keyLines.join("\n")}

Run \`argent config <command> --help\` for command-specific help.`);
}
