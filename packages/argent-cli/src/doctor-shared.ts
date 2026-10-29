import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { getResolvedToolsUrl } from "@argent/tools-client";
import { isYarnPnp, shellQuotePath } from "@argent/installer";

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
  /** The checkout Claude Code runs in, whose .claude dir it reads; projectRoot when unset. */
  claudeRoot?: string;
  /** Claude Code's ~/.claude.json key for this project (see claudeProjectKey); claudeRoot when unset. */
  claudeKey?: string;
  /** cwd's git checkout, where Codex and opencode find project config; projectRoot when unset. */
  gitRoot?: string;
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
  /** Whether npm's global prefix has an `argent`; null when npm can't be asked. */
  npmGlobalHasArgent?: boolean | null;
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
  /** The env key whose `${VAR}` this shell can't fill in, so the remote can't be probed. */
  unresolved?: string;
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

/** A path for a fix line: `~/…` when the shell needs no quotes for it, else quoted in full. */
export function shellPath(p: string): string {
  const short = home(p);
  return /^[\w~./@+:,-]+$/.test(short) ? short : shellQuotePath(p);
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
 * The command that gives this user `mode` (`u+r`, `u+w`) on `p`. chown alone
 * keeps the mode, so a file the user owns needs only chmod.
 */
export function permissionFix(p: string, mode: string, { recursive = false } = {}): string {
  const quoted = shellQuotePath(p);
  const chmod = `chmod ${mode} ${quoted}`;
  let owned: boolean;
  try {
    owned = fs.statSync(p).uid === process.getuid?.();
  } catch {
    owned = false;
  }
  return owned ? chmod : `sudo chown ${recursive ? "-R " : ""}"$USER" ${quoted} && ${chmod}`;
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
