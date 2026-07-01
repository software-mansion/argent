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

// __dirname in ESM (compiled from TS) will be dist/.
// Bundle artifacts ship next to the compiled launcher.
export const BUNDLED_RUNTIME_PATHS: ToolsServerPaths = {
  bundlePath: path.join(import.meta.dirname, "tool-server.cjs"),
  simulatorServerDir: path.join(import.meta.dirname, "..", "bin"),
  nativeDevtoolsDir: path.join(import.meta.dirname, "..", "dylibs"),
  version: readPackageVersion(),
};
