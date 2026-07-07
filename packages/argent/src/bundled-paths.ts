import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolsServerPaths } from "@argent/tools-client";

// The installed package version, read from the shipped package.json (one level
// up from dist/). Lets the launcher detect a stale tool-server after an in-place
// version bump (a local devDependency update rewrites tool-server.cjs at the same
// path) and respawn the new one — WITHOUT depending on the postinstall script,
// which is frequently disabled (--ignore-scripts, pnpm onlyBuiltDependencies,
// Yarn PnP, locked-down CI).
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

// Which install topology this running package belongs to: a project's local
// devDependency (its root sits inside a node_modules reachable by walking up
// from cwd) or the global PATH install — and, for a local install, WHICH
// project: the directory whose node_modules the package root sits under.
// Classified HERE, at process start, because this is the moment cwd is
// trustworthy: a committed local MCP command (`node node_modules/.../cli.js
// mcp`) only resolves when the client set cwd to the project root. The
// launcher forwards both to the tool-server (ARGENT_INSTALL_KIND /
// ARGENT_PROJECT_ROOT) so update-argent doesn't have to re-infer them from the
// detached server's own (editor-chosen, possibly `/`) cwd — the kind pins
// WHICH install an agent-triggered update targets, the root pins WHERE.
const PACKAGE_NAME = "@swmansion/argent";

// The project a local install belongs to: the nearest ancestor of cwd that
// DECLARES the package (any dependency field, matching the installer's
// readManifestDeclaration) or carries a committed .argent/install.json. This
// can sit BELOW the directory whose node_modules physically holds the package
// — npm workspaces hoist a member's devDependency to the workspace root, but
// update/uninstall must act on the declaring member, whose manifest is the one
// that records the pin.
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

function classifyInstall(): { kind: "global" | "local"; projectRoot?: string } {
  let packageRoot: string;
  let dir: string;
  let cwd: string;
  try {
    packageRoot = fs.realpathSync(path.join(import.meta.dirname, ".."));
    // cwd can throw (ENOENT) when the shell's directory was deleted — and this
    // runs at module import, before any fatal handler is installed.
    cwd = process.cwd();
    dir = cwd;
  } catch {
    return { kind: "global" };
  }
  for (;;) {
    try {
      const nmReal = fs.realpathSync(path.join(dir, "node_modules"));
      if (packageRoot === nmReal || packageRoot.startsWith(nmReal + path.sep)) {
        // Local install. Prefer the DECLARING root over this physical hoist
        // root: in a hoisted workspace, cwd (the committed MCP command only
        // resolves with cwd at the member root) or an ancestor below `dir`
        // holds the manifest that actually declares the package.
        return { kind: "local", projectRoot: findDeclaringRoot(cwd) ?? dir };
      }
    } catch {
      // no node_modules at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { kind: "global" };
}

const classifiedInstall = classifyInstall();

// __dirname in ESM (compiled from TS) will be dist/.
// Bundle artifacts ship next to the compiled launcher.
export const BUNDLED_RUNTIME_PATHS: ToolsServerPaths = {
  bundlePath: path.join(import.meta.dirname, "tool-server.cjs"),
  simulatorServerDir: path.join(import.meta.dirname, "..", "bin"),
  nativeDevtoolsDir: path.join(import.meta.dirname, "..", "dylibs"),
  version: readPackageVersion(),
  installKind: classifiedInstall.kind,
  installProjectRoot: classifiedInstall.projectRoot,
};
