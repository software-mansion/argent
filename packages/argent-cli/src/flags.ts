// Feature-flag CLI for argent: the `enable` / `disable` / `flags` commands.
//
// This module is the command layer only — argv parsing and console output. The
// registry, JSON storage, and `isFlagEnabled` live in `@argent/configuration-core`
// (the pure source of truth); the primitives are imported below.
//
// `enable` writes `true` for a registry-listed flag; `disable` removes the entry
// at the chosen scope. `enable` is the only path that consults the registry —
// `disable` stays lenient so a flag removed from the registry can still be
// cleared from storage, and `argent flags` lists such leftovers under an
// "unrecognized" section so they can be cleaned up.

import pc from "picocolors";
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

// Green for enabled, red for disabled. The label is padded first, then wrapped,
// so column alignment is computed from the plain text and never thrown off by
// ANSI escapes. picocolors is a no-op when stdout isn't a TTY or NO_COLOR is
// set, so piped/redirected output stays plain.
function colorState(enabled: boolean): string {
  const label = (enabled ? "enabled" : "disabled").padEnd(8);
  return enabled ? pc.green(label) : pc.red(label);
}

// Flag names: start with a letter, then letters/digits/dot/underscore/dash.
// Keeps file contents predictable and avoids shell-quoting surprises.
const FLAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

interface ParsedToggleArgs {
  name: string;
  scope: FlagScope;
}

function parseToggleArgs(argv: string[], command: "enable" | "disable"): ParsedToggleArgs {
  let name: string | null = null;
  let scope: FlagScope = "global";
  let positionalOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;

    if (positionalOnly) {
      if (name !== null) throw new Error(`Unexpected extra argument: "${tok}"`);
      name = tok;
      continue;
    }

    if (tok === "--") {
      // POSIX positional escape — everything after is treated as a positional.
      positionalOnly = true;
      continue;
    }
    if (tok === "--scope") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--scope requires a value (project|global)");
      scope = parseScope(v);
      i += 1;
      continue;
    }
    if (tok.startsWith("--scope=")) {
      scope = parseScope(tok.slice("--scope=".length));
      continue;
    }
    if (tok.startsWith("--")) {
      throw new Error(`Unknown flag: ${tok}`);
    }
    if (name !== null) {
      throw new Error(`Unexpected extra argument: "${tok}"`);
    }
    name = tok;
  }

  if (name === null) {
    throw new Error(`Usage: argent ${command} <flag-name> [--scope project|global]`);
  }
  if (!FLAG_NAME_RE.test(name)) {
    throw new Error(
      `Invalid flag name "${name}". Must start with a letter and contain only letters, digits, ".", "_", or "-".`
    );
  }
  return { name, scope };
}

function parseScope(raw: string): FlagScope {
  if (raw === "global" || raw === "project") return raw;
  throw new Error(`--scope must be "project" or "global", got "${raw}"`);
}

// Renders the registry as an indented "Available flags:" block for --help
// output: one line per flag, `name <padding> description`, so users can see
// what they can toggle without running `argent flags` first.
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

  // Only registry-listed flags can be enabled. `disable` stays lenient so a
  // flag that was removed from the registry can still be cleared from storage.
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
    } else {
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

// `argent flags` — list every registry flag with its description and effective
// state (project overrides global; unset flags read as disabled).
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

  // Registry-driven view: every known flag, whether or not it is stored.
  // hasOwn guards against prototype-named flags resolving to Object.prototype.
  const registryView = registry.map((def) => {
    const eff = Object.hasOwn(effective, def.name) ? effective[def.name]! : undefined;
    return {
      name: def.name,
      description: def.description,
      enabled: eff?.value ?? false,
      scope: eff?.scope ?? null,
    };
  });

  // Flags still in storage but no longer in the registry (e.g. deprecated and
  // removed). Reading them never errors — they are surfaced here so they stay
  // visible and can be cleared with `argent disable <name>`.
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
