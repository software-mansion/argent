import * as fs from "node:fs";
import * as path from "node:path";

// Filesystem probes that gate the `--devdep` flow. Kept separate from
// topology.ts because these answer "can we run a local install?" rather
// than "do we already have a local install?".

export function hasPackageJson(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, "package.json"));
}

// Yarn 2+ PnP — no literal node_modules/.bin/argent, so the devDep
// flow's MCP command would resolve to nothing. Surface upfront.
export function isYarnPnp(projectRoot: string): boolean {
  return (
    fs.existsSync(path.join(projectRoot, ".pnp.cjs")) ||
    fs.existsSync(path.join(projectRoot, ".pnp.loader.mjs"))
  );
}
