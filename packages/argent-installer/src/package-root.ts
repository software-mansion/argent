import * as fs from "node:fs";
import * as path from "node:path";

// Leaf module with no local imports: both utils.ts (which computes
// PACKAGE_ROOT at module init) and topology.ts depend on this, and utils.ts
// re-exports topology — importing resolvePackageRoot from utils there created
// a genuine ESM cycle that only worked because the function was called lazily.

// At runtime this package ships in two shapes:
//   - tsc-compiled in the monorepo: packages/argent-installer/dist/*.js
//   - bundled into the published package: <pkg>/dist/installer.mjs
// Walking up to the nearest package.json works for both layouts and any
// future repacking, instead of hard-coding a "two levels up" assumption.

/**
 * Given a starting dirname, walk up until the first directory containing a
 * package.json. Falls back to the starting directory if none found. Exported
 * so it can be tested against simulated directory structures.
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
