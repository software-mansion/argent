import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = path.resolve(import.meta.dirname, "..");

const DISPATCHER_BUNDLES = [
  { file: "installer.mjs", exportName: "init" },
  { file: "mcp-server.mjs", exportName: "startMcpServer" },
  { file: "cli-cmds.mjs", exportName: "run" },
];

function runNode(args: string[]) {
  return spawnSync(process.execPath, args, { cwd: pkgRoot, encoding: "utf8" });
}

/** Loads the bundle in a real node subprocess, since vitest's import() injects its own __dirname. */
function exportTypeOf(file: string, exportName: string) {
  const url = pathToFileURL(path.join(pkgRoot, "dist", file)).href;
  return runNode([
    "--input-type=module",
    "-e",
    `const m = await import(${JSON.stringify(url)}); process.stdout.write(typeof m.${exportName});`,
  ]);
}

describe("bundle-tools.cjs --esm-only (npm run dev)", () => {
  it("builds the bundles dist/cli.js imports, and each one loads", () => {
    const build = runNode(["scripts/bundle-tools.cjs", "--esm-only"]);
    expect(build.stderr).toBe("");
    expect(build.status).toBe(0);

    for (const { file, exportName } of DISPATCHER_BUNDLES) {
      const load = exportTypeOf(file, exportName);
      expect(load.stderr, file).toBe("");
      expect(load.stdout, file).toBe("function");
    }
  }, 60_000);
});
