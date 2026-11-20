import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import pc from "picocolors";
import { PACKAGE_NAME } from "./constants.js";
import type { PackageManager } from "./package-manager.js";

// npm derives its global prefix from the node binary's location, so under Nix
// it lands inside the read-only store and `npm install -g` dies with EACCES.

const GLOBAL_DIR_QUERY: Record<PackageManager, readonly string[]> = {
  npm: ["root", "-g"],
  pnpm: ["root", "-g"],
  yarn: ["global", "dir"],
  bun: ["pm", "bin", "-g"],
};

const QUERY_TIMEOUT_MS = 5_000;

function queryGlobalInstallDir(pm: PackageManager): string | null {
  let stdout: string;
  try {
    stdout = execFileSync(pm, [...GLOBAL_DIR_QUERY[pm]], {
      encoding: "utf8",
      timeout: QUERY_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const line = String(stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (line === undefined || !path.isAbsolute(line)) return null;
  // npm prints UUID-shaped segments as `***`; probing that path's nearest
  // existing ancestor would judge the wrong directory.
  return line.includes("***") ? null : line;
}

export function isNixStorePath(target: string): boolean {
  const storeDir = realPath(process.env.NIX_STORE_DIR || "/nix/store");
  const resolved = realPath(target);
  return resolved === storeDir || resolved.startsWith(storeDir + path.sep);
}

// A store path that does not exist is still a store path by name.
function realPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function nearestExistingDir(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // Missing or unstattable — keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isRealDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

interface GlobalInstallTarget {
  /** The directory that was judged; when blocked, the one that cannot be written. */
  dir: string;
  blocked: boolean;
  nixStore: boolean;
}

// Only these errnos prove a directory cannot be written.
const BLOCKING_ERRNOS = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Whether this user can write where a global install by `pm` would.
 * Anything inconclusive returns null: wrongly refusing an install that would
 * work is worse than the failure being prevented.
 */
export function probeGlobalInstallTarget(pm: PackageManager): GlobalInstallTarget | null {
  // Windows access(W_OK) reflects only the read-only attribute, not ACLs.
  if (process.platform === "win32") return null;

  const queried = queryGlobalInstallDir(pm);
  if (queried === null) return null;
  const packageDir = path.join(queried, PACKAGE_NAME);
  const parent = nearestExistingDir(path.dirname(packageDir));
  if (parent === null) return null;

  // npm renames the package directory inside its parent, so either one left
  // root-owned by an earlier `sudo npm i -g` blocks it. A symlinked package
  // is only unlinked; its target is never written.
  const dirs = isRealDirectory(packageDir) ? [parent, packageDir] : [parent];
  for (const dir of dirs) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !BLOCKING_ERRNOS.has(code)) return null;
      return { dir, blocked: true, nixStore: isNixStorePath(dir) };
    }
  }
  return { dir: parent, blocked: false, nixStore: isNixStorePath(parent) };
}

/** `localInit` is the per-project command as the user can run it from here. */
export function unwritableGlobalTargetMessage(
  target: GlobalInstallTarget,
  pm: PackageManager,
  verb: "install" | "update",
  localInit = "argent init --local"
): string {
  const cause = target.nixStore
    ? "its global package directory is inside the read-only Nix store"
    : "its global package directory is not writable by this user";
  const note = target.nixStore
    ? `Nix store paths are meant to be immutable — do not install into them with ${pc.cyan("sudo")}.`
    : "Nothing was installed or changed.";

  const remedies: string[] = [
    pm === "npm"
      ? `  Point npm at a writable prefix, then retry:\n` +
        `    ${pc.cyan('npm config set prefix "$HOME/.npm-global"')}\n` +
        `    ${pc.cyan('export PATH="$HOME/.npm-global/bin:$PATH"')}  ${pc.dim("(add to your shell profile)")}`
      : `  Point ${pc.cyan(pm)} at a global directory you can write to, then retry.`,
    `  Or use ${PACKAGE_NAME} per project instead — no global directory needed:\n` +
      `    ${pc.cyan(localInit)}`,
  ];

  return (
    `${pc.cyan(pm)} cannot ${verb} ${PACKAGE_NAME} globally: ${cause}.\n` +
    `  ${pc.dim(target.dir)}\n` +
    `${note}\n\n` +
    remedies.join("\n\n")
  );
}
