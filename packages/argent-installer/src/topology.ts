import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  detectPackageManager,
  globalInstallCommand,
  globalUninstallCommand,
  localDevInstallCommand,
  localDevUninstallCommand,
  type PackageManager,
  type ShellCommand,
} from "./package-manager.js";
import { MCP_BINARY_NAME, PACKAGE_NAME } from "./constants.js";
import { resolvePackageRoot } from "./utils.js";

// Argent supports two independent install topologies:
//   - global: argent is on the user's PATH (historical default).
//   - local : argent is a project devDependency under
//             <projectRoot>/node_modules/@swmansion/argent. This is the
//             "team-share" flow — the MCP config can be committed.
//
// They can coexist: a developer can have a global install AND a project
// devDep. update/uninstall iterate TOPOLOGIES so each is probed and
// handled independently.

export type TopologyId = "global" | "local";

export interface TopologyState {
  readonly installed: boolean;
  /** Version reported by the install on disk, NOT the running module. */
  readonly version: string | null;
}

export interface Topology {
  readonly id: TopologyId;
  /** Short label for UI ("global package", "local devDependency"). */
  readonly label: string;
  /** Probe presence + version. */
  probe(projectRoot: string): TopologyState;
  installCommand(projectRoot: string, pkg: string): ShellCommand;
  uninstallCommand(projectRoot: string, pkg: string): ShellCommand;
  /** cwd to spawn the install/uninstall child with (undefined = inherit). */
  spawnCwd(projectRoot: string): string | undefined;
}

// ── Path segments used by temp package runners ──────────────────────────
// When argent is invoked via npx / pnpm dlx / bunx / yarn dlx, the runner
// prepends its cache .bin/ dir to PATH, so `which argent` succeeds even
// though argent is not permanently installed globally. Filter these out
// so a concurrent npx invocation doesn't mask a real (or missing) global.
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

function readJsonSafely<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

// ── Global topology ─────────────────────────────────────────────────────

function probeGlobal(): TopologyState {
  const binaryPath = getGlobalBinaryPath();
  if (!binaryPath) return { installed: false, version: null };

  let version: string | null = null;
  try {
    const realPath = fs.realpathSync(binaryPath);
    const pkgRoot = resolvePackageRoot(path.dirname(realPath));
    const pkg = readJsonSafely<{ version?: string }>(path.join(pkgRoot, "package.json"));
    version = pkg?.version ?? null;
  } catch {
    // Couldn't follow the symlink (Windows .cmd wrappers) — leave version null.
  }
  return { installed: true, version };
}

export const GLOBAL: Topology = {
  id: "global",
  label: "global package",
  probe: () => probeGlobal(),
  installCommand: (_root, pkg) => globalInstallCommand(detectPackageManager(), pkg),
  uninstallCommand: (_root, pkg) => globalUninstallCommand(detectPackageManager(), pkg),
  // Global install doesn't depend on the project tree — inherit the cwd.
  spawnCwd: () => undefined,
};

// ── Local topology ──────────────────────────────────────────────────────

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function localPackageJsonPath(projectRoot: string): string {
  return path.join(projectRoot, "node_modules", "@swmansion", "argent", "package.json");
}

// A real consumer install requires BOTH a dep declaration in the project's
// package.json AND the files on disk. The declaration check disambiguates
// from npm/yarn workspaces where node_modules/@swmansion/argent is a
// symlink to the workspace source (workspace members don't list themselves
// in the root manifest).
function isDeclaredAsDependency(projectRoot: string): boolean {
  const pkg = readJsonSafely<{ [field: string]: Record<string, unknown> | undefined }>(
    path.join(projectRoot, "package.json")
  );
  if (!pkg) return false;
  return DEPENDENCY_FIELDS.some((field) => Boolean(pkg[field]?.[PACKAGE_NAME]));
}

function readLocalVersion(projectRoot: string): string | null {
  const pkg = readJsonSafely<{ version?: string }>(localPackageJsonPath(projectRoot));
  return pkg?.version ?? null;
}

function probeLocal(projectRoot: string): TopologyState {
  if (!isDeclaredAsDependency(projectRoot)) return { installed: false, version: null };
  if (!fs.existsSync(localPackageJsonPath(projectRoot))) return { installed: false, version: null };
  return { installed: true, version: readLocalVersion(projectRoot) };
}

export const LOCAL: Topology = {
  id: "local",
  label: "local devDependency",
  probe: (root) => probeLocal(root),
  installCommand: (root, pkg) => localDevInstallCommand(detectPackageManager(root), pkg),
  uninstallCommand: (root, pkg) => localDevUninstallCommand(detectPackageManager(root), pkg),
  spawnCwd: (root) => root,
};

// ── Registry ────────────────────────────────────────────────────────────

export const TOPOLOGIES: ReadonlyArray<Topology> = [GLOBAL, LOCAL];

export function topologyById(id: TopologyId): Topology {
  return id === "global" ? GLOBAL : LOCAL;
}

// Convenience predicates kept for older call sites that don't want the
// full TopologyState object. New code should call topology.probe().
export function isGloballyInstalled(): boolean {
  return GLOBAL.probe("").installed;
}

export function isLocallyInstalled(projectRoot: string): boolean {
  return LOCAL.probe(projectRoot).installed;
}

export function getGloballyInstalledVersion(): string | null {
  return GLOBAL.probe("").version;
}

// Pure file read — independent of dep declaration. Returns whatever is on
// disk under node_modules/@swmansion/argent so post-install reporting
// reflects the real version even when the manifest hasn't been refreshed
// yet (e.g. mid-install state).
export function getLocallyInstalledVersion(projectRoot: string): string | null {
  return readLocalVersion(projectRoot);
}
