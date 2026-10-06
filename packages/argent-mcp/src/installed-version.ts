import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Version reported in the MCP `initialize` handshake (`serverInfo.version`).
 *
 * The parent of the compiled file's dist/ is @swmansion/argent's shipped
 * package.json once published (dist/mcp-server.mjs ships next to dist/cli.js)
 * and @argent/mcp's own in the dev workspace; packages/* are version-locked
 * (scripts/check-workspace-versions.mjs), so either source is correct.
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
