import * as fs from "node:fs";
import * as path from "node:path";

// Leaf module with no local imports: utils.ts (which computes PACKAGE_ROOT at
// module init) and topology.ts both depend on this, and utils.ts re-exports
// topology — housing resolvePackageRoot in utils created an ESM cycle.

// The package ships in two shapes — tsc-compiled (packages/argent-installer/
// dist/*.js) and bundled (<pkg>/dist/installer.mjs) — so walk up to the nearest
// package.json rather than hard-coding a "two levels up" assumption.

/**
 * Walk up from `dirname` to the first directory containing a package.json;
 * falls back to the starting directory when none is found.
 */
export function resolvePackageRoot(dirname: string): string {
  let current = path.resolve(dirname);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(dirname);
    current = parent;
  }
}
