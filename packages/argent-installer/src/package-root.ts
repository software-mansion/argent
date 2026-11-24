import * as fs from "node:fs";
import * as path from "node:path";

// Leaf module: topology.ts needs resolvePackageRoot and utils.ts re-exports
// topology, so keeping it in utils.ts closed an ESM cycle.

// The package ships tsc-compiled (dist/*.js) and bundled (<pkg>/dist/installer.mjs)
// at differing depths, so walk up rather than assume a fixed number of levels.

export function resolvePackageRoot(dirname: string): string {
  let current = path.resolve(dirname);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(dirname);
    current = parent;
  }
}
