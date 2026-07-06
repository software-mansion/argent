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
// from cwd) or the global PATH install. Classified HERE, at process start,
// because this is the moment cwd is trustworthy: a committed local MCP command
// (`node node_modules/.../cli.js mcp`) only resolves when the client set cwd to
// the project root. The launcher forwards it to the tool-server as
// ARGENT_INSTALL_KIND so update-argent doesn't have to re-infer it from the
// detached server's own (editor-chosen, possibly `/`) cwd.
function classifyInstallKind(): "global" | "local" {
  let packageRoot: string;
  let dir: string;
  try {
    packageRoot = fs.realpathSync(path.join(import.meta.dirname, ".."));
    // cwd can throw (ENOENT) when the shell's directory was deleted — and this
    // runs at module import, before any fatal handler is installed.
    dir = process.cwd();
  } catch {
    return "global";
  }
  for (;;) {
    try {
      const nmReal = fs.realpathSync(path.join(dir, "node_modules"));
      if (packageRoot === nmReal || packageRoot.startsWith(nmReal + path.sep)) {
        return "local";
      }
    } catch {
      // no node_modules at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "global";
}

// __dirname in ESM (compiled from TS) will be dist/.
// Bundle artifacts ship next to the compiled launcher.
export const BUNDLED_RUNTIME_PATHS: ToolsServerPaths = {
  bundlePath: path.join(import.meta.dirname, "tool-server.cjs"),
  simulatorServerDir: path.join(import.meta.dirname, "..", "bin"),
  nativeDevtoolsDir: path.join(import.meta.dirname, "..", "dylibs"),
  version: readPackageVersion(),
  installKind: classifyInstallKind(),
};
