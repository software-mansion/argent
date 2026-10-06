// Feature-flag CLI for argent: the `enable` / `disable` / `flags` commands.
// Command layer only — argv parsing and console output; the registry and JSON
// storage live in `@argent/configuration-core`.

import pc from "picocolors";
import { parseCommandArgs, UsageError, type OptionSpecs } from "./command-args.js";
import {
  FLAG_REGISTRY,
  getFlagDefinition,
  getFlagsPath,
  readFlags,
  setFlag,
  unsetFlag,
  type FlagScope,
  type FlagDefinition,
} from "@argent/configuration-core";

// Pad before coloring so column alignment ignores ANSI escapes. Gate on isTTY
// ourselves because picocolors also enables color when CI is set, which would
// leak escapes into piped output.
function colorState(enabled: boolean): string {
  const label = (enabled ? "enabled" : "disabled").padEnd(8);
  if (!process.stdout.isTTY) return label;
  return enabled ? pc.green(label) : pc.red(label);
}

// Avoids shell-quoting surprises and keeps stored keys predictable.
const FLAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

interface ParsedToggleArgs {
  name: string;
  scope: FlagScope;
}

// "project" first so the error lists the scopes in the order the help does.
const TOGGLE_OPTIONS = {
  scope: { kind: "value", choices: ["project", "global"] },
} as const satisfies OptionSpecs;

function parseToggleArgs(argv: string[], command: "enable" | "disable"): ParsedToggleArgs {
  const { positionals, options } = parseCommandArgs(argv, TOGGLE_OPTIONS);
  const [name, extra] = positionals;
  if (extra !== undefined) throw new UsageError(`Unexpected extra argument: "${extra}"`);
  if (name === undefined) {
    throw new UsageError(`Usage: argent ${command} <flag-name> [--scope project|global]`);
  }
  if (!FLAG_NAME_RE.test(name)) {
    throw new UsageError(
      `Invalid flag name "${name}". Must start with a letter and contain only letters, digits, ".", "_", or "-".`
    );
  }
  return { name, scope: (options.scope as FlagScope | undefined) ?? "global" };
}

// Shown in --help so users see what they can toggle without running `argent flags`.
function formatAvailableFlags(registry: readonly FlagDefinition[]): string {
  if (registry.length === 0) {
    return "Available flags:\n  (none defined)";
  }
  const maxName = registry.reduce((m, def) => Math.max(m, def.name.length), 0);
  const lines = registry.map((def) => `  ${def.name.padEnd(maxName)}  ${def.description}`);
  return ["Available flags:", ...lines].join("\n");
}

function printToggleHelp(command: "enable" | "disable", registry: readonly FlagDefinition[]): void {
  const summary =
    command === "enable"
      ? "Enable a predefined feature flag (see `argent flags`) at the chosen scope."
      : "Remove a feature flag entry at the chosen scope. Falls back to the global value if set; otherwise the flag is treated as off.";

  console.log(`Usage: argent ${command} <flag-name> [--scope project|global]

${summary}

${formatAvailableFlags(registry)}

Storage:
  ~/.argent/flags.json                 (global, default)
  <project-root>/.argent/flags.json    (project, with --scope project)

Options:
  --scope <global|project>   Where to write (default: global)
  --help, -h                 Show this help
`);
}

function runToggle(
  argv: string[],
  command: "enable" | "disable",
  registry: readonly FlagDefinition[]
): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    printToggleHelp(command, registry);
    return;
  }

  let parsed: ParsedToggleArgs;
  try {
    parsed = parseToggleArgs(argv, command);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  // `disable` stays lenient so a flag dropped from the registry can still be
  // cleared from storage.
  if (command === "enable" && getFlagDefinition(parsed.name, registry) === undefined) {
    console.error(
      `Error: Unknown feature flag "${parsed.name}". Run \`argent flags\` to see available flags.`
    );
    process.exit(2);
  }

  const filePath = getFlagsPath(parsed.scope);
  try {
    if (command === "enable") {
      setFlag(parsed.name, true, parsed.scope);
    } else if (getFlagDefinition(parsed.name, registry)?.defaultEnabled) {
      // Opt-out flag: persist an explicit `false`; unsetting would revert it
      // to its ON default.
      setFlag(parsed.name, false, parsed.scope);
    } else {
      // Opt-in flag: the off default takes over once the entry is gone.
      unsetFlag(parsed.name, parsed.scope);
    }
  } catch (err) {
    console.error(`Failed to ${command} flag: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (command === "enable") {
    console.log(`Enabled flag "${parsed.name}" (${parsed.scope}). Stored at ${filePath}.`);
  } else {
    console.log(`Disabled flag "${parsed.name}" (${parsed.scope}).`);
  }
}

export function enable(argv: string[], registry: readonly FlagDefinition[] = FLAG_REGISTRY): void {
  runToggle(argv, "enable", registry);
}

export function disable(argv: string[], registry: readonly FlagDefinition[] = FLAG_REGISTRY): void {
  runToggle(argv, "disable", registry);
}

// `argent flags` — every registry flag with its description and effective state
// (project overrides global).
export function flags(argv: string[], registry: readonly FlagDefinition[] = FLAG_REGISTRY): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: argent flags [--json]

List the available feature flags and their current state. Flags are
predefined; project-scoped values override global ones.

${formatAvailableFlags(registry)}

Options:
  --json   Print machine-readable JSON
`);
    return;
  }

  const json = argv.includes("--json");
  const projectFlags = readFlags("project");
  const globalFlags = readFlags("global");

  const effective: Record<string, { value: boolean; scope: FlagScope }> = {};
  for (const [k, v] of Object.entries(globalFlags)) effective[k] = { value: v, scope: "global" };
  for (const [k, v] of Object.entries(projectFlags)) effective[k] = { value: v, scope: "project" };

  // Every registry flag, stored or not. hasOwn guards against prototype-named
  // flags resolving to Object.prototype.
  const registryView = registry.map((def) => {
    const eff = Object.hasOwn(effective, def.name) ? effective[def.name]! : undefined;
    return {
      name: def.name,
      description: def.description,
      // An unset opt-out flag reads as on (its declared default).
      enabled: eff?.value ?? def.defaultEnabled ?? false,
      scope: eff?.scope ?? null,
    };
  });

  // Stored flags no longer in the registry — surfaced so they can be cleared
  // with `argent disable <name>`.
  const known = new Set(registry.map((def) => def.name));
  const unrecognized = Object.keys(effective)
    .filter((name) => !known.has(name))
    .sort()
    .map((name) => ({ name, enabled: effective[name]!.value, scope: effective[name]!.scope }));

  if (json) {
    console.log(
      JSON.stringify(
        {
          flags: registryView,
          unrecognized,
          global: globalFlags,
          project: projectFlags,
          effective,
          paths: {
            global: getFlagsPath("global"),
            project: getFlagsPath("project"),
          },
        },
        null,
        2
      )
    );
    return;
  }

  if (registryView.length === 0) {
    console.log("No feature flags are defined.");
  } else {
    console.log("Feature flags (project overrides global):");
    const maxName = registryView.reduce((m, f) => Math.max(m, f.name.length), 0);
    for (const f of registryView) {
      const scopeLabel = f.scope ? ` (${f.scope})` : "";
      console.log(`  ${f.name.padEnd(maxName, " ")}  ${colorState(f.enabled)}${scopeLabel}`);
      console.log(`  ${" ".repeat(maxName)}  ${f.description}`);
    }
  }

  if (unrecognized.length > 0) {
    console.log("\nStored but no longer recognized (safe to `argent disable`):");
    const maxName = unrecognized.reduce((m, f) => Math.max(m, f.name.length), 0);
    for (const f of unrecognized) {
      console.log(`  ${f.name.padEnd(maxName, " ")}  ${colorState(f.enabled)} (${f.scope})`);
    }
  }

  console.log(`\n  Global:  ${getFlagsPath("global")}`);
  console.log(`  Project: ${getFlagsPath("project")}`);
}
