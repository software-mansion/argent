// Feature-flag source of truth for argent.
//
// Flags are simple boolean toggles stored as JSON in:
//   ~/.argent/flags.json                 (global, default scope)
//   <project-root>/.argent/flags.json    (project scope)
//
// This package is the pure library: the registry, JSON storage, and
// `isFlagEnabled`. It has no console I/O — the `enable`/`disable`/`flags` CLI
// commands live in `@argent/cli` and import the primitives below.
//
// `setFlag` writes a boolean, `unsetFlag` removes the entry at the chosen scope.
// `isFlagEnabled` walks project → global, so an entry at the project scope
// shadows the same key at the global scope. To opt a single project out of
// a globally-enabled flag, hand-edit `<project>/.argent/flags.json` to
// `{"flags":{"name":false}}` — there is no CLI for an explicit override.
//
// FLAG_REGISTRY below is the single source of truth for which flags exist:
// `argent enable` only accepts a name listed there, and `argent flags`
// documents every entry. `isFlagEnabled` only reads storage — it never
// consults the registry, keeping runtime callers decoupled from CLI validation.
//
// Deprecating a flag is safe: only the *write* path (`argent enable`) consults
// the registry. Every read path (readFlags / isFlagEnabled / `argent flags`)
// loads whatever booleans are stored regardless of the registry, so removing an
// entry from FLAG_REGISTRY never errors on a flags.json that still contains it.

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export type FlagScope = "global" | "project";

interface FlagsFile {
  flags?: Record<string, boolean>;
}

// A recognized feature flag. `name` is what users pass to enable/disable and
// what `isFlagEnabled` reads; `description` is shown by `argent flags`.
export interface FlagDefinition {
  readonly name: string;
  readonly description: string;
}

// The flags argent recognizes. Adding one entry here is the only change needed
// to make `argent enable <name>` accept it and `argent flags` document it.
export const FLAG_REGISTRY: readonly FlagDefinition[] = [
  {
    name: "disable-auto-screenshot",
    description: "Disable the automatic screenshot captured after interaction tools.",
  },
  {
    name: "variant-selection",
    description:
      "Variant proposal & selection UI — the propose_variant / await_user_selection tools and the Electron preview window. Off by default while the feature is in development.",
  },
  {
    name: "artifacts-list-endpoint",
    description: "Expose GET /artifacts for remote artifact inventory consumers.",
  },
];

// Look up a flag's definition — exported for consumers that want the
// description alongside isFlagEnabled(). Defaults to the built-in registry.
export function getFlagDefinition(
  name: string,
  registry: readonly FlagDefinition[] = FLAG_REGISTRY
): FlagDefinition | undefined {
  return registry.find((def) => def.name === name);
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
  // Atomic write via tmp+rename so a reader never observes a torn/partial JSON
  // payload. (Concurrent read-modify-write is still last-writer-wins, but two
  // argent CLI invocations racing on the same flag file are not expected.)
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
  // hasOwn, not `in`: flag names like "toString"/"constructor" are valid
  // identifiers but live on Object.prototype, so `in` would report them as
  // present (and delete a no-op) even when they were never stored.
  if (!Object.hasOwn(current, name)) return false;
  delete current[name];
  writeFlagsFile(filePath, current);
  return true;
}

// Effective value: project overrides global. Returns false when the flag is
// not set in either scope — flags are opt-in.
export function isFlagEnabled(name: string, options: FlagsPathOptions = {}): boolean {
  // hasOwn, not `in`: otherwise prototype keys ("toString", "constructor", …)
  // resolve to a truthy Object.prototype member for a flag that was never set.
  const projectFlags = readFlags("project", options);
  if (Object.hasOwn(projectFlags, name)) return projectFlags[name]!;
  const globalFlags = readFlags("global", options);
  if (Object.hasOwn(globalFlags, name)) return globalFlags[name]!;
  return false;
}
