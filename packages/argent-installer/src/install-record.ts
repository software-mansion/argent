import * as fs from "node:fs";
import * as path from "node:path";
import { isDeclaredLocally } from "./topology.js";

// Committed marker recording that a project uses local (devDependency) mode, so
// `update`/`uninstall` and teammates act on the repo-local install rather than a
// global one. Only written for local mode — global mode stays zero-footprint.

export type InstallMode = "global" | "local";

export interface InstallRecord {
  mode: InstallMode;
  package: string;
  writtenBy?: string;
}

export function getInstallRecordPath(projectRoot: string): string {
  return path.join(projectRoot, ".argent", "install.json");
}

export function readInstallRecord(projectRoot: string): InstallRecord | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getInstallRecordPath(projectRoot), "utf8")
    ) as InstallRecord;
    if (parsed && (parsed.mode === "local" || parsed.mode === "global")) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeInstallRecord(projectRoot: string, record: InstallRecord): void {
  const recordPath = getInstallRecordPath(projectRoot);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
}

export function removeInstallRecord(projectRoot: string): boolean {
  const recordPath = getInstallRecordPath(projectRoot);
  try {
    if (!fs.existsSync(recordPath)) return false;
    fs.rmSync(recordPath, { force: true });
    const dir = path.dirname(recordPath);
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // non-fatal — sibling files (flags.json, …) keep .argent alive
    }
    return true;
  } catch {
    return false;
  }
}

// Effective install mode: the committed record wins; otherwise infer local
// only from a dep the project's own package.json declares — a copy merely in
// node_modules (hoisted/transitive) is not intent. Default global (all
// pre-record installs were global).
export function resolveInstallMode(projectRoot: string): InstallMode {
  const record = readInstallRecord(projectRoot);
  if (record) return record.mode;
  return isDeclaredLocally(projectRoot) ? "local" : "global";
}

export class InstallModeFlagError extends Error {}

// Resolve the install mode from `argent init` flags; null means "ask the user
// interactively". Throws InstallModeFlagError on conflicting flags.
//
// `recordedMode` is the mode the project already opted into (committed
// .argent/install.json, or a manifest-declared dep — see init.ts). A
// non-interactive run honors it so `argent init -y` in a local-mode repo
// doesn't silently convert it back to global. Explicit flags still win.
export function resolveInstallModeFromFlags(opts: {
  local: boolean;
  global: boolean;
  nonInteractive: boolean;
  recordedMode?: InstallMode | null;
}): InstallMode | null {
  if (opts.local && opts.global) {
    throw new InstallModeFlagError("--local and --global are mutually exclusive.");
  }
  if (opts.local) return "local";
  if (opts.global) return "global";
  if (opts.nonInteractive) return opts.recordedMode ?? "global";
  return null;
}
