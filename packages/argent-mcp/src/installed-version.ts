import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Version reported in the MCP `initialize` handshake (`serverInfo.version`).
 *
 * Resolved from the package.json one directory above the executing file —
 * the same pattern as `getInstalledVersion()` in packages/argent/src/cli.ts:
 * in the published package the bundled `dist/mcp-server.mjs` sits next to
 * `dist/cli.js`, so two-up is @swmansion/argent's shipped package.json; in
 * the dev workspace the compiled file resolves @argent/mcp's own package.json.
 * Both are version-bumped in lockstep, so either source is correct — unlike
 * the hardcoded literal this replaces, which had drifted several releases
 * behind the actual install.
 */
export function getInstalledVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
