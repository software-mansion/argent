// Feature-flag storage + CLI for argent.
//
// Flags are simple boolean toggles stored as JSON in:
//   ~/.argent/flags.json                 (global, default scope)
//   <project-root>/.argent/flags.json    (project scope)
//
// Project-scoped values override global ones for code running inside the
// project tree (isFlagEnabled walks project first, then global). `enable` and
// `disable` both write an explicit boolean — disable is not a delete — so a
// user can override a global enable inside a single project by running
// `argent disable <flag> --scope project`.

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export type FlagScope = "global" | "project";

interface FlagsFile {
  flags?: Record<string, boolean>;
}

// Markers used to find the project root for --scope project. Walks upward
// from the cwd until one is found, mirroring the project-root logic used by
// the installer so flags land alongside .mcp.json / .claude / etc.
const PROJECT_MARKERS = [
  ".argent",
  ".git",
  ".mcp.json",
  ".claude",
  ".cursor",
  ".vscode",
  ".gemini",
  ".codex",
  ".agents",
  "package.json",
];

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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: FlagsFile = { flags };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n");
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

class ToggleArgsHelpRequested {}

function parseToggleArgs(argv: string[], command: "enable" | "disable"): ParsedToggleArgs {
  let name: string | null = null;
  let scope: FlagScope = "global";

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--help" || tok === "-h") {
      throw new ToggleArgsHelpRequested();
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
  const verb = command === "enable" ? "Enable" : "Disable";
  console.log(`Usage: argent ${command} <flag-name> [--scope project|global]

${verb} a feature flag. Flags are stored as JSON in:
  ~/.argent/flags.json                 (global, default)
  <project-root>/.argent/flags.json    (project, with --scope project)

Project-scoped flags override global ones for code running inside the
project's working tree. The project root is the nearest ancestor with a
.argent, .git, package.json, .mcp.json, or recognised editor directory.

Options:
  --scope <global|project>   Where to write the value (default: global)
  --help, -h                 Show this help
`);
}

function runToggle(argv: string[], command: "enable" | "disable"): void {
  let parsed: ParsedToggleArgs;
  try {
    parsed = parseToggleArgs(argv, command);
  } catch (err) {
    if (err instanceof ToggleArgsHelpRequested) {
      printToggleHelp(command);
      return;
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const value = command === "enable";
  try {
    setFlag(parsed.name, value, parsed.scope);
  } catch (err) {
    console.error(`Failed to ${command} flag: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const filePath = getFlagsPath(parsed.scope);
  const verb = command === "enable" ? "Enabled" : "Disabled";
  console.log(`${verb} flag "${parsed.name}" (${parsed.scope}). Stored at ${filePath}.`);
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
