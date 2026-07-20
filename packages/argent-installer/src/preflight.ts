import * as fs from "node:fs";
import * as path from "node:path";

// Filesystem probes that gate the local (devDependency) install flow. These
// answer "can we run a local install here?" rather than "do we already have
// one?" (the latter lives in topology.ts).

export function hasProjectPackageJson(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, "package.json"));
}

// Yarn Plug'n'Play installs have NO node_modules, so a `node node_modules/...`
// command can never resolve. Detect PnP so local mode can emit a `yarn argent
// mcp` entry instead.
export function isYarnPnp(projectRoot: string): boolean {
  return (
    fs.existsSync(path.join(projectRoot, ".pnp.cjs")) ||
    fs.existsSync(path.join(projectRoot, ".pnp.loader.mjs"))
  );
}
