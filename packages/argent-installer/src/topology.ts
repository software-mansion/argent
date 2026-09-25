import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import semver from "semver";
import { PACKAGE_NAME, MCP_BINARY_NAME } from "./constants.js";
import { resolvePackageRoot } from "./package-root.js";
import { isYarnPnp } from "./preflight.js";

// Two install topologies that can coexist: global (argent on PATH, the default)
// and local (project dependency, the committable "team-share" flow).
// update/uninstall probe and handle each independently.

// `which argent` also matches temp package runners (npx / pnpm dlx / bunx /
// yarn dlx), which prepend their cache .bin/ dir to PATH.
const TEMP_RUNNER_MARKERS = [
  "_npx",
  "/dlx-",
  "\\dlx-",
  "bun/install/cache",
  ".bun\\install\\cache",
];

function isTempRunnerPath(binaryPath: string): boolean {
  return TEMP_RUNNER_MARKERS.some((marker) => binaryPath.includes(marker));
}

/**
 * Path of the globally-installed argent binary, or null when argent is not
 * permanently on PATH. Checks every match so a concurrent temp-runner
 * invocation does not mask a real global install.
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

/** True iff argent is permanently on PATH, not run from an npx / dlx cache. */
export function isGloballyInstalled(): boolean {
  return getGlobalBinaryPath() !== null;
}

// Shared by both resolution paths below: walk up from `dir` to the nearest
// package.json and accept the root only when it is actually argent's.
// resolvePackageRoot walks up to the FIRST package.json, which can be an
// unrelated manifest (e.g. a stray `~/package.json`) when the bin isn't a
// symlink straight into the package (a cmd-shim, or a Windows `argent.cmd`).
// An over-broad root would make killToolServerForInstallDir kill unrelated
// installs' tool-servers.
function packageRootIfNamed(dir: string): string | null {
  try {
    const root = resolvePackageRoot(dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: string;
    };
    return pkg.name === PACKAGE_NAME ? root : null;
  } catch {
    return null;
  }
}

// npm's global bin is a symlink straight into the package, so realpath +
// walk-up crosses into it directly.
function packageRootFromRealpath(binaryPath: string): string | null {
  try {
    const realPath = fs.realpathSync(binaryPath);
    return packageRootIfNamed(path.dirname(realPath));
  } catch {
    return null;
  }
}

// 64 KiB is generous for a shim (real ones are a few dozen lines); a file
// past that size — or one holding a NUL byte — isn't a text shim, so treat it
// as unreadable rather than risk parsing something else as one.
const MAX_SHIM_FILE_SIZE = 64 * 1024;

// pnpm's cmd-shim (both the POSIX `sh` shim it writes and the Windows `.cmd`
// it writes alongside it — untested here, but read the same way) appends the
// resolved absolute target as a trailing comment. Trust it over parsing the
// shim body.
const SHIM_TRAILER_PATTERN = /^# cmd-shim-target=(.+)$/m;

// Otherwise the shim body execs a quoted path relative to its own directory:
// `"$basedir/../..."` (POSIX sh) or `"%~dp0\...\"` / `"%dp0%\...\"` (Windows
// .cmd; `%~dp0/` is accepted too).
const SHIM_BODY_TARGET_PATTERN = /["']((?:\$basedir|%~dp0|%dp0%)[\\/][^"']*)["']/g;

function findShimTarget(contents: string, shimDir: string): string | null {
  const trailerTarget = SHIM_TRAILER_PATTERN.exec(contents)?.[1]?.trim();
  if (trailerTarget) return trailerTarget;

  // Several quoted candidates can appear (one per node-binary fallback branch
  // in pnpm's POSIX shim) — they all point at the same target, so the first
  // one that actually lands inside argent's package wins.
  const marker = `node_modules/${PACKAGE_NAME}/`;
  const pattern = new RegExp(SHIM_BODY_TARGET_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(contents)) !== null) {
    // Normalize to `/` first (Windows fixtures are exercised on Linux too),
    // then strip whichever prefix matched.
    const normalized = match[1]!.split("\\").join("/");
    const rel = normalized.replace(/^(?:\$basedir|%~dp0|%dp0%)\//, "");
    const resolved = path.resolve(shimDir, rel);
    if (resolved.split(path.sep).join("/").includes(marker)) return resolved;
  }
  return null;
}

// A bin-dir shim (pnpm's cmd-shim, or an npm/pnpm Windows .cmd) is a REGULAR
// file, not a symlink into the package, so realpath + walk-up never reaches
// argent's package.json. Read the shim's own text for the path it execs
// instead.
function packageRootFromShim(binaryPath: string): string | null {
  let contents: string;
  try {
    if (fs.statSync(binaryPath).size > MAX_SHIM_FILE_SIZE) return null;
    contents = fs.readFileSync(binaryPath, "utf8");
    if (contents.includes("\0")) return null;
  } catch {
    return null;
  }

  const target = findShimTarget(contents, path.dirname(binaryPath));
  return target ? packageRootIfNamed(path.dirname(target)) : null;
}

/**
 * Root directory of the globally-installed argent package, or null when argent
 * is not on PATH or the layout can't be resolved. Used to read the installed
 * version and to scope tool-server teardown to THIS install.
 */
export function getGloballyInstalledPackageRoot(): string | null {
  const binaryPath = getGlobalBinaryPath();
  if (!binaryPath) return null;
  return packageRootFromRealpath(binaryPath) ?? packageRootFromShim(binaryPath);
}

/**
 * Version of the globally-installed argent package — NOT the running one
 * ({@link import("./utils.js").getInstalledVersion}): under `npx` the running
 * copy is the always-latest cache, which would mask an outdated global install.
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
 * True iff the project's own package.json declares @swmansion/argent — the
 * intent signal for local mode. A copy merely present in node_modules (hoisted
 * transitive dep, workspace symlink) is NOT an opt-in.
 */
export function isDeclaredLocally(projectRoot: string): boolean {
  return readManifestDeclaration(projectRoot) !== null;
}

/**
 * Directory of the project-local @swmansion/argent, via Node module resolution
 * from the project root (handles hoisted and pnpm layouts). Null when
 * unresolvable: not installed, or Yarn PnP without its resolver loaded.
 */
function resolveLocalArgentDir(projectRoot: string): string | null {
  try {
    const req = createRequire(path.join(projectRoot, "package.json"));
    // No `exports` map today, so the package.json subpath resolves; the catch
    // covers a future map hiding it.
    return path.dirname(req.resolve(`${PACKAGE_NAME}/package.json`));
  } catch {
    const plain = path.join(projectRoot, "node_modules", PACKAGE_NAME);
    return fs.existsSync(path.join(plain, "package.json")) ? plain : null;
  }
}

interface LocalInstallProbe {
  /**
   * Resolvable on disk, or declared in the manifest under Yarn PnP (which has
   * no node_modules and whose resolver isn't loaded here).
   */
  installed: boolean;
  /** Under PnP, falls back to the declared specifier when it is exact semver. */
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

export function isLocallyInstalled(projectRoot: string): boolean {
  return probeLocalInstall(projectRoot).installed;
}

// The copy `update` compares against, as opposed to the running package
// (getInstalledVersion) or the global install (getGloballyInstalledVersion).
export function getLocallyInstalledVersion(projectRoot: string): string | null {
  return probeLocalInstall(projectRoot).version;
}

// Bypasses Node's module-resolution realpath cache, which makes
// resolveLocalArgentDir still report the OLD version right after an in-process
// install. `update` uses this to confirm a bump landed even when the package
// manager exited non-zero.
export function readLocalPackageVersionUncached(projectRoot: string): string | null {
  try {
    const pkgPath = path.join(projectRoot, "node_modules", PACKAGE_NAME, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * The package-relative path of argent's CLI entrypoint (today `dist/cli.js`),
 * read from the installed `package.json`'s `bin` rather than hard-coded, so a
 * rename can never leave a caller pointing at a file that isn't there.
 */
export function argentBinSubpath(pkgDir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    if (typeof pkg.bin === "string") return pkg.bin;
    if (pkg.bin && typeof pkg.bin === "object") {
      return pkg.bin[MCP_BINARY_NAME] ?? Object.values(pkg.bin)[0] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

// Project-relative POSIX path to the local argent CLI entrypoint (e.g.
// "node_modules/@swmansion/argent/dist/cli.js"). Derived from the installed
// package.json `bin` and existence-checked so it never writes a dead command;
// forward slashes keep the committed command valid on Windows too.
export function getLocalArgentBinRelPath(projectRoot: string): string | null {
  const pkgDir = resolveLocalArgentDir(projectRoot);
  if (!pkgDir) return null;
  const binSub = argentBinSubpath(pkgDir);
  if (!binSub) return null;
  // Realpath the root so a symlinked project dir (macOS /var → /private/var)
  // doesn't derail the relative path with spurious ".." segments.
  let root = projectRoot;
  try {
    root = fs.realpathSync(projectRoot);
  } catch {
    // keep the caller's path
  }
  // Prefer the STABLE node_modules path: module resolution returns the symlink
  // TARGET — under pnpm the version-pinned .pnpm store dir, which pnpm prunes
  // on the next bump, breaking the committed MCP command.
  const stableRel = path.join("node_modules", PACKAGE_NAME, binSub);
  if (fs.existsSync(path.join(root, stableRel))) {
    return stableRel.split(path.sep).join("/");
  }
  // Hoisted layouts (package above the project's own node_modules): the
  // resolved path is still committable, just less bump-resilient.
  const abs = path.join(pkgDir, binSub);
  if (!fs.existsSync(abs)) return null;
  return path.relative(root, abs).split(path.sep).join("/");
}
