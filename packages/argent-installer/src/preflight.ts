import * as fs from "node:fs";
import * as path from "node:path";

// Filesystem probes gating the local (devDependency) install flow; "is it
// already installed?" lives in topology.ts.

export function hasProjectPackageJson(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, "package.json"));
}

// Yarn PnP has no node_modules, so a `node node_modules/...` entry can never
// resolve; local mode emits `yarn argent mcp` instead.
export function isYarnPnp(projectRoot: string): boolean {
  return (
    fs.existsSync(path.join(projectRoot, ".pnp.cjs")) ||
    fs.existsSync(path.join(projectRoot, ".pnp.loader.mjs"))
  );
}
