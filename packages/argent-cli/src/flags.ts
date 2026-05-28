// Feature-flag storage + CLI for argent.
//
// Flags are simple boolean toggles stored as JSON in:
//   ~/.argent/flags.json                 (global, default scope)
//   <project-root>/.argent/flags.json    (project scope)
//
// `enable` writes `true`, `disable` removes the entry at the chosen scope.
// `isFlagEnabled` walks project → global, so an entry at the project scope
// shadows the same key at the global scope. To opt a single project out of
// a globally-enabled flag, hand-edit `<project>/.argent/flags.json` to
// `{"flags":{"name":false}}` — there is no CLI for an explicit override.

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export type FlagScope = "global" | "project";

interface FlagsFile {
  flags?: Record<string, boolean>;
}

// Markers used to find the project root for --scope project. Trimmed to the
// minimum needed: an existing `.argent` (so subsequent runs in subdirs find
// the dir created by the first run), a git repo, or an npm package.
const PROJECT_MARKERS = [".argent", ".git", "package.json"];

export interface FlagsPathOptions {
  cwd?: string;
  homeDir?: string;
}

export function resolveProjectRoot(startDir: string): string {
  const initial = path.resolve(startDir);
  let current = initial;
  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

export function getFlagsPath(scope: FlagScope, options: FlagsPathOptions = {}): string {
  const home = options.homeDir ?? homedir();
  if (scope === "global") {
    return path.join(home, ".argent", "flags.json");
  }
  const cwd = options.cwd ?? process.cwd();
  return path.join(resolveProjectRoot(cwd), ".argent", "flags.json");
}

function readFlagsFile(filePath: string): Record<string, boolean> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const flags = (parsed as FlagsFile).flags;
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

function writeFlagsFile(filePath: string, flags: Record<string, boolean>): void {
  // No flags left ⇒ remove the file (and the .argent dir if it becomes empty)
  // so disable-after-enable round trips leave a clean tree. Sibling files
  // (tool-server.json, tool-server.log, etc.) keep the dir alive when present.
  if (Object.keys(flags).length === 0) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    const parent = path.dirname(filePath);
    try {
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    } catch {
      // non-fatal
    }
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic write via tmp+rename so two concurrent argent processes can't
  // produce a torn JSON payload or lose each other's edits.
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ flags } satisfies FlagsFile, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

export function readFlags(
  scope: FlagScope,
  options: FlagsPathOptions = {}
): Record<string, boolean> {
  return readFlagsFile(getFlagsPath(scope, options));
}

export function setFlag(
  name: string,
  value: boolean,
  scope: FlagScope,
  options: FlagsPathOptions = {}
): void {
  const filePath = getFlagsPath(scope, options);
  const current = readFlagsFile(filePath);
  current[name] = value;
  writeFlagsFile(filePath, current);
}

// Removes the entry from the given scope so the next layer (or the default)
// takes effect. Returns true when an entry was removed.
export function unsetFlag(name: string, scope: FlagScope, options: FlagsPathOptions = {}): boolean {
  const filePath = getFlagsPath(scope, options);
  const current = readFlagsFile(filePath);
  if (!(name in current)) return false;
  delete current[name];
  writeFlagsFile(filePath, current);
  return true;
}

// Effective value: project overrides global. Returns false when the flag is
// not set in either scope — flags are opt-in.
export function isFlagEnabled(name: string, options: FlagsPathOptions = {}): boolean {
  const projectFlags = readFlags("project", options);
  if (name in projectFlags) return projectFlags[name]!;
  const globalFlags = readFlags("global", options);
  if (name in globalFlags) return globalFlags[name]!;
  return false;
}

// ── CLI handlers ──────────────────────────────────────────────────────────────

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

function printToggleHelp(command: "enable" | "disable"): void {
  const summary =
    command === "enable"
      ? "Enable a feature flag at the chosen scope."
      : "Remove a feature flag entry at the chosen scope. Falls back to the global value if set; otherwise the flag is treated as off.";

  console.log(`Usage: argent ${command} <flag-name> [--scope project|global]

${summary}

Storage:
  ~/.argent/flags.json                 (global, default)
  <project-root>/.argent/flags.json    (project, with --scope project)

Options:
  --scope <global|project>   Where to write (default: global)
  --help, -h                 Show this help
`);
}

function runToggle(argv: string[], command: "enable" | "disable"): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    printToggleHelp(command);
    return;
  }

  let parsed: ParsedToggleArgs;
  try {
    parsed = parseToggleArgs(argv, command);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
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

export function enable(argv: string[]): void {
  runToggle(argv, "enable");
}

export function disable(argv: string[]): void {
  runToggle(argv, "disable");
}

// `argent flags` — show what is currently set, grouped by scope, with the
// effective (project-wins) view.
export function flags(argv: string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: argent flags [--json]

Show the current state of feature flags. Project-scoped flags override
global ones.

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

  if (json) {
    console.log(
      JSON.stringify(
        {
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

  const allNames = Object.keys(effective).sort();
  if (allNames.length === 0) {
    console.log("No flags set.");
    console.log(`  Global:  ${getFlagsPath("global")}`);
    console.log(`  Project: ${getFlagsPath("project")}`);
    return;
  }

  console.log("Effective flags (project overrides global):");
  const maxName = allNames.reduce((m, n) => Math.max(m, n.length), 0);
  for (const name of allNames) {
    const { value, scope } = effective[name]!;
    const stateLabel = value ? "enabled" : "disabled";
    console.log(`  ${name.padEnd(maxName, " ")}  ${stateLabel.padEnd(8)} (${scope})`);
  }
  console.log(`\n  Global:  ${getFlagsPath("global")}`);
  console.log(`  Project: ${getFlagsPath("project")}`);
}
