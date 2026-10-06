import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolsServerPaths } from "@argent/tools-client";

// Installed package version, read from the shipped package.json. Feeds the
// launcher's version gate as the fallback for its on-disk read, so an in-place
// bump (a local devDependency update rewrites tool-server.cjs at the same
// path) retires the stale tool-server with no install-time hook: install
// scripts are frequently disabled (--ignore-scripts, pnpm's build gate, Yarn
// PnP, locked-down CI), which is why argent ships no postinstall script.
function readPackageVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")
    ) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

const PACKAGE_NAME = "@swmansion/argent";

// The project a local install belongs to: the nearest ancestor of cwd that
// DECLARES the package (any dependency field, matching the installer's
// readManifestDeclaration) or carries a committed .argent/install.json. Can
// sit BELOW the physical hoist root — npm workspaces hoist a member's
// devDependency, but update/uninstall must act on the declaring member.
function findDeclaringRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".argent", "install.json"))) return dir;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      if (
        manifest.devDependencies?.[PACKAGE_NAME] ||
        manifest.dependencies?.[PACKAGE_NAME] ||
        manifest.optionalDependencies?.[PACKAGE_NAME]
      ) {
        return dir;
      }
    } catch {
      // no/unreadable manifest at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The version-STABLE package dir: the conventional <dir>/node_modules/<pkg>
// symlink closest to cwd that resolves to the running package. Unlike
// import.meta's realpath — pnpm's version-pinned .pnpm store dir, pruned on a
// bump — this symlink survives an in-place update. Scan every level from cwd
// up: in a pnpm WORKSPACE the symlink sits in the DECLARING member's
// node_modules, below the root where the .pnpm store lives. The realpath check
// means the result is only ever another alias of the same real dir.
export function findStablePackageDir(startDir: string, packageRoot: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", PACKAGE_NAME);
    try {
      if (fs.realpathSync(candidate) === packageRoot) return candidate;
    } catch {
      // no symlink at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Install topology of this running package: a project's local devDependency
// (package root inside a node_modules found by walking up from cwd) or the
// global PATH install — and, for local, WHICH project. Classified at process
// start, while cwd is still trustworthy; the launcher forwards both as
// ARGENT_INSTALL_KIND / ARGENT_PROJECT_ROOT so update-argent doesn't re-infer
// them from the detached server's editor-chosen cwd.
function classifyInstall(): {
  kind: "global" | "local";
  projectRoot?: string;
  stablePackageDir?: string;
} {
  let packageRoot: string;
  let dir: string;
  let cwd: string;
  try {
    packageRoot = fs.realpathSync(path.join(import.meta.dirname, ".."));
    // cwd throws (ENOENT) when the shell's directory was deleted, and this runs
    // at module import, before fatal handlers are installed.
    cwd = process.cwd();
    dir = cwd;
  } catch {
    return { kind: "global" };
  }
  for (;;) {
    try {
      const nmReal = fs.realpathSync(path.join(dir, "node_modules"));
      if (packageRoot === nmReal || packageRoot.startsWith(nmReal + path.sep)) {
        // Prefer the DECLARING root over this physical hoist root: in a
        // hoisted workspace the declaring manifest sits at cwd (the member
        // root) or an ancestor below `dir`.
        return {
          kind: "local",
          projectRoot: findDeclaringRoot(cwd) ?? dir,
          stablePackageDir: findStablePackageDir(cwd, packageRoot),
        };
      }
    } catch {
      // no node_modules at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Yarn PnP has no node_modules anywhere: the package runs from the project's
  // .yarn dir. Falling through to "global" would point the update at a global
  // install the user may not even have.
  if (packageRoot.includes(`${path.sep}.yarn${path.sep}`)) {
    const declRoot = findDeclaringRoot(cwd);
    if (declRoot) return { kind: "local", projectRoot: declRoot };
  }
  return { kind: "global" };
}

const classifiedInstall = classifyInstall();

// import.meta.dirname is dist/ in the published package, so ".." is the
// package root; prefer the version-stable alias when classification found one.
const packageDir = classifiedInstall.stablePackageDir ?? path.join(import.meta.dirname, "..");

export const BUNDLED_RUNTIME_PATHS: ToolsServerPaths = {
  bundlePath: path.join(packageDir, "dist", "tool-server.cjs"),
  simulatorServerDir: path.join(packageDir, "bin"),
  nativeDevtoolsDir: path.join(packageDir, "dylibs"),
  version: readPackageVersion(),
  installKind: classifiedInstall.kind,
  installProjectRoot: classifiedInstall.projectRoot,
};
