import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import semver from "semver";
import { PACKAGE_NAME, MCP_BINARY_NAME } from "./constants.js";
import { resolvePackageRoot } from "./package-root.js";
import { isYarnPnp } from "./preflight.js";

// Argent supports two independent install topologies:
//   - global: argent is on the user's PATH (the historical default).
//   - local : argent is a project dependency resolvable from the project root
//             — the committable "team-share" flow.
// They can coexist; update/uninstall probe and handle each independently.

// Paths `which argent` can return that are NOT a real global install: temp
// package runners (npx / pnpm dlx / bunx / yarn dlx) prepend their cache
// .bin/ dir to PATH.
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
 * Path of the globally-installed argent binary, or null when argent is not
 * permanently on PATH. Inspects every `where` / `which -a` match so a
 * concurrent temp-runner invocation does not mask a real global install.
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
 * Root directory of the globally-installed argent package, or null when argent
 * is not on PATH or the layout can't be resolved. Used to read the installed
 * version and to scope tool-server teardown to servers from THIS install.
 */
export function getGloballyInstalledPackageRoot(): string | null {
  const binaryPath = getGlobalBinaryPath();
  if (!binaryPath) return null;
  try {
    const realPath = fs.realpathSync(binaryPath);
    const root = resolvePackageRoot(path.dirname(realPath));
    // resolvePackageRoot walks up to the FIRST package.json, which can be an
    // unrelated manifest (e.g. a stray `~/package.json`) when the bin is a
    // non-symlink wrapper like a Windows `argent.cmd`. Callers feed this root
    // to killToolServerForInstallDir, so an over-broad root would tear down
    // unrelated installs' tool-servers — only trust a root that is really ours.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: string;
    };
    return pkg.name === PACKAGE_NAME ? root : null;
  } catch {
    return null;
  }
}

/**
 * Version of the globally-installed argent package — NOT the running package
 * ({@link import("./utils.js").getInstalledVersion}): under `npx` the running
 * copy is the always-latest npx cache, which would mask an outdated global
 * install. Null when argent is not on PATH or the layout can't be resolved.
 */
export function getGloballyInstalledVersion(): string | null {
  const pkgRoot = getGloballyInstalledPackageRoot();
  if (!pkgRoot) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

// ── Local install probes ──────────────────────────────────────────────────────

interface ManifestDeps {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readManifestDeclaration(projectRoot: string): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
    ) as ManifestDeps;
    const spec =
      pkg.devDependencies?.[PACKAGE_NAME] ??
      pkg.dependencies?.[PACKAGE_NAME] ??
      pkg.optionalDependencies?.[PACKAGE_NAME];
    return typeof spec === "string" ? spec : null;
  } catch {
    return null;
  }
}

/**
 * True iff the project's own package.json declares @swmansion/argent. This is
 * the intent signal for local mode: a copy merely present in node_modules
 * (hoisted transitive dep, workspace symlink) is NOT an opt-in.
 */
export function isDeclaredLocally(projectRoot: string): boolean {
  return readManifestDeclaration(projectRoot) !== null;
}

/**
 * Directory of the project-local @swmansion/argent package, via Node module
 * resolution from the project root (handles hoisted and pnpm layouts). Null
 * when unresolvable (not installed, or Yarn PnP without its resolver loaded).
 */
export function resolveLocalArgentDir(projectRoot: string): string | null {
  try {
    const req = createRequire(path.join(projectRoot, "package.json"));
    // No `exports` map today, so the package.json subpath resolves; the catch
    // falls back to the plain node_modules path in case a future map hides it.
    return path.dirname(req.resolve(`${PACKAGE_NAME}/package.json`));
  } catch {
    const plain = path.join(projectRoot, "node_modules", PACKAGE_NAME);
    return fs.existsSync(path.join(plain, "package.json")) ? plain : null;
  }
}

export interface LocalInstallProbe {
  /**
   * True when the package is present for this project: resolvable on disk, or
   * declared in the manifest under Yarn PnP (which has no node_modules and
   * whose resolver isn't loaded here).
   */
  installed: boolean;
  /**
   * Installed version when it can be read. Under PnP this falls back to the
   * declared specifier when it is an exact semver; null when unknown.
   */
  version: string | null;
  /** Absolute package directory when resolvable on disk; null under PnP. */
  packageDir: string | null;
}

export function probeLocalInstall(projectRoot: string): LocalInstallProbe {
  const packageDir = resolveLocalArgentDir(projectRoot);
  if (packageDir) {
    let version: string | null;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
        version?: string;
      };
      version = pkg.version ?? null;
    } catch {
      version = null;
    }
    return { installed: true, version, packageDir };
  }
  if (isYarnPnp(projectRoot)) {
    const spec = readManifestDeclaration(projectRoot);
    if (spec !== null) {
      return { installed: true, version: semver.valid(spec) ? spec : null, packageDir: null };
    }
  }
  return { installed: false, version: null, packageDir: null };
}

// True iff @swmansion/argent is installed for this project (resolvable from
// the project root, or a declared dep under Yarn PnP).
export function isLocallyInstalled(projectRoot: string): boolean {
  return probeLocalInstall(projectRoot).installed;
}

// Version of the project-local @swmansion/argent — the copy `update` must
// compare against, as opposed to the running package (getInstalledVersion) or
// the global install (getGloballyInstalledVersion).
export function getLocallyInstalledVersion(projectRoot: string): string | null {
  return probeLocalInstall(projectRoot).version;
}

// Version read straight from <projectRoot>/node_modules/<pkg>/package.json,
// bypassing Node's module-resolution realpath cache: resolveLocalArgentDir
// memoizes the symlink's realpath for the process lifetime, so right after an
// in-process install it can still report the OLD version. `update` uses this
// to confirm a bump landed even when the package manager exited non-zero.
// Null when there is no copy at that path.
export function readLocalPackageVersionUncached(projectRoot: string): string | null {
  try {
    const pkgPath = path.join(projectRoot, "node_modules", PACKAGE_NAME, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

// Project-relative POSIX path to the local argent CLI entrypoint (e.g.
// "node_modules/@swmansion/argent/dist/cli.js"), or null when the package isn't
// installed or its bin can't be resolved. Derived from the installed
// package.json `bin` (and existence-checked) so it never writes a dead command;
// forward slashes keep the committed command valid on Windows too.
export function getLocalArgentBinRelPath(projectRoot: string): string | null {
  const pkgDir = resolveLocalArgentDir(projectRoot);
  if (!pkgDir) return null;
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
  // Realpath the root so a symlinked project dir (e.g. macOS /var → /private/var)
  // doesn't derail the relative path with spurious ".." segments.
  let root = projectRoot;
  try {
    root = fs.realpathSync(projectRoot);
  } catch {
    // keep the caller's path
  }
  // Prefer the STABLE node_modules path over the resolved real path: module
  // resolution returns the symlink TARGET — under pnpm the version-pinned
  // .pnpm store dir. Committing that bakes the version into the MCP command,
  // which breaks on the next bump (pnpm prunes the old store dir); the
  // <root>/node_modules/<pkg> symlink stays valid across bumps.
  const stableRel = path.join("node_modules", PACKAGE_NAME, binSub);
  if (fs.existsSync(path.join(root, stableRel))) {
    return stableRel.split(path.sep).join("/");
  }
  // Fallback for hoisted layouts (package above the project's own node_modules):
  // use the resolved path — still committable, just less bump-resilient.
  const abs = path.join(pkgDir, binSub);
  if (!fs.existsSync(abs)) return null;
  return path.relative(root, abs).split(path.sep).join("/");
}
