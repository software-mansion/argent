import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { getResolvedToolsUrl } from "@argent/tools-client";
import { isYarnPnp } from "@argent/installer";

// Types and helpers every `argent doctor` section shares.

export type CheckStatus = "ok" | "warn" | "error" | "info";

export interface DoctorCheck {
  status: CheckStatus;
  label: string;
  detail?: string;
  /** The command or action that resolves a warn/error. */
  fix?: string;
}

export interface DoctorSection {
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  version: string;
  node: string;
  platform: string;
  projectRoot: string;
  sections: DoctorSection[];
  errors: number;
  warnings: number;
}

export type ResolvedToolsUrl = Awaited<ReturnType<typeof getResolvedToolsUrl>>;

/** Facts every section shares, probed once per run. */
export interface DoctorContext {
  projectRoot: string;
  /** Claude Code's project (see claudeProjectKey); projectRoot when unset. */
  claudeRoot?: string;
  /** Where doctor runs: global-scope `node <relative>` entries resolve from here. */
  cwd: string;
  mode: "global" | "local";
  global: GlobalInstall | null;
  /** How to spell an argent command in a fix line (`argent`, or via npx when not on PATH). */
  argentCmd: string;
  /** The project's own install command (`pnpm install`, …). */
  installCmd: string;
  /** Bin dir of the running global install when it is not on PATH. */
  offPathGlobalBin: string | null;
  /** macOS: the PATH launchd gives apps started from the Dock. */
  guiPath?: string | null;
}

export interface GlobalInstall {
  bin: string;
  /** Package root, when the bin links into one (npm). Null for script shims (pnpm, Yarn). */
  root: string | null;
  version: string | null;
  /** Why the shim failed to run from the project, when it did (see runGlobalShim). */
  runError?: string;
}

/** A tool-server an entry points at through its own ARGENT_TOOLS_URL. */
export interface EntryToolsUrl {
  editor: string;
  url: string;
  token?: string;
}

export function check(
  status: CheckStatus,
  label: string,
  extra: Omit<DoctorCheck, "status" | "label"> = {}
): DoctorCheck {
  return { status, label, ...extra };
}

export function home(p: string): string {
  const h = homedir();
  if (h === path.sep || !h) return p;
  return p === h || p.startsWith(h + path.sep) ? `~${p.slice(h.length)}` : p;
}

/** The real path of `p`, or of its nearest existing ancestor (a config file may not exist yet). */
export function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realPath(parent), path.basename(p));
  }
}

export function samePath(a: string, b: string | null | undefined): boolean {
  return !!b && realPath(a) === realPath(b);
}

export function isUnreadable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EACCES";
  }
}

/**
 * The cause of a failed `--check-deps` run. execFile's message starts with a
 * bare "Command failed: <cmd>"; the reason is in stderr. A crash on load
 * prints a code frame and a stack around the error line, so pick that line.
 */
export function childFailureReason(stderr: string, fallback: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // `TypeError: …`, but also V8's `FATAL ERROR: …` and mise's `mise ERROR …`.
  return lines.find((l) => /^[\w.]*Error\b|\bERROR\b/.test(l)) ?? lines[0] ?? fallback;
}

export function localArgentCmd(projectRoot: string): string {
  return isYarnPnp(projectRoot) ? "yarn argent" : "npx argent";
}
