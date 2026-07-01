import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { PACKAGE_NAME, MCP_BINARY_NAME } from "./constants.js";
import { resolvePackageRoot } from "./utils.js";
import {
  detectPackageManager,
  detectProjectPackageManager,
  globalInstallCommand,
  globalUninstallCommand,
  localInstallCommand,
  localUninstallCommand,
  type ShellCommand,
} from "./package-manager.js";

// Argent supports two independent install topologies:
//   - global: argent is on the user's PATH (the historical default).
//   - local : argent is a project devDependency under
//             <projectRoot>/node_modules/@swmansion/argent. This is the
//             committable "team-share" flow — the MCP config can be committed.
//
// They can coexist (a developer can have a global install AND a project
// devDep). update/uninstall consult the topology so each is probed and handled
// independently.

export type TopologyId = "global" | "local";

export interface TopologyState {
  readonly installed: boolean;
  /** Version reported by the install on disk, NOT the running module. */
  readonly version: string | null;
}

export interface Topology {
  readonly id: TopologyId;
  /** Short label for UI ("global package" / "local devDependency"). */
  readonly label: string;
  /** Probe presence + on-disk version. */
  probe(projectRoot: string): TopologyState;
  installCommand(projectRoot: string, pkg: string): ShellCommand;
  uninstallCommand(projectRoot: string, pkg: string): ShellCommand;
  /** cwd to spawn the install/uninstall child with (undefined = inherit). */
  spawnCwd(projectRoot: string): string | undefined;
}

// ── Paths that `which argent` can return but are NOT a real global install ──
// Temp package runners (npx / pnpm dlx / bunx / yarn dlx) prepend their cache
// .bin/ dir to PATH, so `which argent` succeeds even though argent is not
// permanently installed globally.
const TEMP_RUNNER_MARKERS = [
  "_npx",
  "/dlx-",
  "\\dlx-",
  "bun/install/cache",
  ".bun\\install\\cache",
];

export function isTempRunnerPath(binaryPath: string): boolean {
  return TEMP_RUNNER_MARKERS.some((marker) => binaryPath.includes(marker));
}

/**
 * Resolve the path of the globally-installed argent binary, ignoring
 * temp-runner caches (npx / pnpm dlx / bunx / yarn dlx). On Windows `where`
 * returns every match, on Unix `which -a` does — we inspect each line so a
 * concurrent npx invocation does not mask a real global install. Returns
 * null when argent is not permanently installed on PATH.
 */
function getGlobalBinaryPath(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which -a";
    const output = execSync(`${cmd} ${MCP_BINARY_NAME}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .find((line) => !isTempRunnerPath(line)) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * True iff argent is permanently installed on the user's PATH (not just being
 * executed transiently from an npx / dlx / bunx cache).
 */
export function isGloballyInstalled(): boolean {
  return getGlobalBinaryPath() !== null;
}

/**
 * Read the version of the globally-installed argent package — distinct from
 * {@link import("./utils.js").getInstalledVersion}, which reads the package.json
 * this code is currently executing from. When invoked via `npx`, the npx cache
 * is always at the latest published version, so reading the running package
 * masks an outdated global install. This resolves the global binary via
 * `which -a` / `where`, follows symlinks to the real entrypoint, and walks up to
 * the owning package.json. Returns null when argent is not on PATH or the layout
 * can't be resolved (e.g. Windows wrapper scripts that aren't symlinks).
 */
export function getGloballyInstalledVersion(): string | null {
  const binaryPath = getGlobalBinaryPath();
  if (!binaryPath) return null;
  try {
    const realPath = fs.realpathSync(binaryPath);
    const pkgRoot = resolvePackageRoot(path.dirname(realPath));
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

// ── Local install probes ──────────────────────────────────────────────────────

function getLocalArgentDir(projectRoot: string): string {
  return path.join(projectRoot, "node_modules", PACKAGE_NAME);
}

// True iff @swmansion/argent is installed in the project's node_modules. Used to
// infer local mode when no install record exists, and to decide whether `update`
// should bump the devDep vs the global binary.
export function isLocallyInstalled(projectRoot: string): boolean {
  return fs.existsSync(path.join(getLocalArgentDir(projectRoot), "package.json"));
}

// Version of the project-local @swmansion/argent. Distinct from
// getInstalledVersion (the running package) and getGloballyInstalledVersion:
// under `npx`/local mode the running package is the npx cache, so the project's
// own node_modules copy is the version `update` must compare against.
export function getLocallyInstalledVersion(projectRoot: string): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(getLocalArgentDir(projectRoot), "package.json"), "utf8")
    ) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

// Project-relative POSIX path to the locally-installed argent CLI entrypoint
// (e.g. "node_modules/@swmansion/argent/dist/cli.js"), or null when the package
// isn't installed locally or its bin can't be resolved. Derived from the
// installed package.json `bin` (and existence-checked) rather than hardcoded, so
// it survives a future entrypoint move and never writes a dead command. Forward
// slashes keep the committed command valid on every OS (Node accepts them on
// Windows too).
export function getLocalArgentBinRelPath(projectRoot: string): string | null {
  const pkgDir = getLocalArgentDir(projectRoot);
  let binSub: string | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    if (typeof pkg.bin === "string") binSub = pkg.bin;
    else if (pkg.bin && typeof pkg.bin === "object")
      binSub = pkg.bin[MCP_BINARY_NAME] ?? Object.values(pkg.bin)[0];
  } catch {
    return null;
  }
  if (!binSub) return null;
  const abs = path.join(pkgDir, binSub);
  if (!fs.existsSync(abs)) return null;
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}

// ── Topology objects ──────────────────────────────────────────────────────────

export const GLOBAL: Topology = {
  id: "global",
  label: "global package",
  probe: () => ({ installed: isGloballyInstalled(), version: getGloballyInstalledVersion() }),
  installCommand: (_root, pkg) => globalInstallCommand(detectPackageManager(), pkg),
  uninstallCommand: (_root, pkg) => globalUninstallCommand(detectPackageManager(), pkg),
  // Global install doesn't depend on the project tree — inherit the cwd.
  spawnCwd: () => undefined,
};

export const LOCAL: Topology = {
  id: "local",
  label: "local devDependency",
  probe: (root) => ({
    installed: isLocallyInstalled(root),
    version: getLocallyInstalledVersion(root),
  }),
  installCommand: (root, pkg) => localInstallCommand(detectProjectPackageManager(root), pkg),
  uninstallCommand: (root, pkg) => localUninstallCommand(detectProjectPackageManager(root), pkg),
  spawnCwd: (root) => root,
};

export const TOPOLOGIES: ReadonlyArray<Topology> = [GLOBAL, LOCAL];

export function topologyById(id: TopologyId): Topology {
  return id === "global" ? GLOBAL : LOCAL;
}
