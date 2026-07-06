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
//             (usually a devDependency). This is the committable "team-share"
//             flow — the MCP config can be committed.
//
// They can coexist (a developer can have a global install AND a project
// devDep). update/uninstall consult the topology so each is probed and handled
// independently.

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
 * Root directory of the globally-installed argent package (the dir holding its
 * package.json), or null when argent is not on PATH or the layout can't be
 * resolved. Follows the bin symlink to the real entrypoint and walks up to the
 * owning package.json. Used both to read the installed version and to scope
 * tool-server teardown to servers spawned from THIS install.
 */
export function getGloballyInstalledPackageRoot(): string | null {
  const binaryPath = getGlobalBinaryPath();
  if (!binaryPath) return null;
  try {
    const realPath = fs.realpathSync(binaryPath);
    const root = resolvePackageRoot(path.dirname(realPath));
    // resolvePackageRoot walks up to the FIRST package.json, which is only
    // argent's when the bin resolves cleanly into the package dir. If the bin is
    // a non-symlink wrapper (a Windows `argent.cmd` in the npm prefix, which
    // realpath leaves unchanged) or the layout is unexpected, the walk can land
    // on an unrelated manifest — classically a stray `~/package.json`. Callers
    // feed this root to killToolServerForInstallDir, so an over-broad root would
    // tear down tool-servers of unrelated installs. Only trust a root whose
    // package.json is actually ours.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: string;
    };
    return pkg.name === PACKAGE_NAME ? root : null;
  } catch {
    return null;
  }
}

/**
 * Read the version of the globally-installed argent package — distinct from
 * {@link import("./utils.js").getInstalledVersion}, which reads the package.json
 * this code is currently executing from. When invoked via `npx`, the npx cache
 * is always at the latest published version, so reading the running package
 * masks an outdated global install. Returns null when argent is not on PATH or
 * the layout can't be resolved (e.g. Windows wrapper scripts that aren't
 * symlinks).
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
 * True iff the project's own package.json declares @swmansion/argent as a
 * dependency. This is the intent signal for local mode: a copy that merely
 * exists in node_modules (hoisted transitive dep, workspace symlink, a
 * teammate's experiment) is NOT evidence the project opted into the
 * committable install.
 */
export function isDeclaredLocally(projectRoot: string): boolean {
  return readManifestDeclaration(projectRoot) !== null;
}

/**
 * Directory of the project-local @swmansion/argent package, resolved with
 * Node's module resolution from the project root — handles hoisted workspace
 * layouts and pnpm symlinks that a hardcoded <root>/node_modules/<pkg> path
 * misses. Null when the package can't be resolved (not installed, or a Yarn
 * PnP layout whose resolver isn't loaded in this process).
 */
export function resolveLocalArgentDir(projectRoot: string): string | null {
  try {
    const req = createRequire(path.join(projectRoot, "package.json"));
    // The published package has no `exports` map, so the package.json subpath
    // resolves directly. Fall back to the plain node_modules path in case a
    // future exports map hides it.
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

// True iff @swmansion/argent is installed for this project (resolvable from the
// project root, or a declared dep under Yarn PnP). Used by `update`/`uninstall`
// once local mode is resolved, and by init's post-install verification.
export function isLocallyInstalled(projectRoot: string): boolean {
  return probeLocalInstall(projectRoot).installed;
}

// Version of the project-local @swmansion/argent. Distinct from
// getInstalledVersion (the running package) and getGloballyInstalledVersion:
// under `npx`/local mode the running package is the npx cache, so the project's
// own resolved copy is the version `update` must compare against.
export function getLocallyInstalledVersion(projectRoot: string): string | null {
  return probeLocalInstall(projectRoot).version;
}

// Version read straight from <projectRoot>/node_modules/<pkg>/package.json,
// bypassing Node's module-resolution realpath cache. resolveLocalArgentDir
// (via createRequire) memoizes the symlink's realpath for the process lifetime,
// so right after an in-process `pnpm add`/`npm install` bumps the version it can
// still report the OLD one (the pnpm store dir it first resolved still exists).
// `update` uses this to confirm a bump actually landed even when the package
// manager exited non-zero. Reads through the stable symlink so it follows to the
// freshly-linked version; null when there is no copy at that path.
export function readLocalPackageVersionUncached(projectRoot: string): string | null {
  try {
    const pkgPath = path.join(projectRoot, "node_modules", PACKAGE_NAME, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
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
  // Prefer the STABLE, version-independent node_modules path over the resolved
  // real path. resolveLocalArgentDir uses Node's module resolution, which
  // returns the symlink TARGET — under pnpm that is the version-pinned
  // node_modules/.pnpm/@swmansion+argent@<version>/... store dir. Committing
  // that bakes the current version into the MCP command, so it breaks the moment
  // the dependency is bumped outside `argent update` (a plain `pnpm update`
  // prunes the old store dir). The conventional <root>/node_modules/<pkg> path
  // is a symlink to the same file yet stays valid across version bumps.
  const stableRel = path.join("node_modules", PACKAGE_NAME, binSub);
  if (fs.existsSync(path.join(root, stableRel))) {
    return stableRel.split(path.sep).join("/");
  }
  // Fallback for layouts where the package isn't under the project's own
  // node_modules (hoisted workspace root): use the resolved path. Still
  // committable, just less resilient to an in-place version bump.
  const abs = path.join(pkgDir, binSub);
  if (!fs.existsSync(abs)) return null;
  return path.relative(root, abs).split(path.sep).join("/");
}
