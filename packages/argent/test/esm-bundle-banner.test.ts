import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as esbuild from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

// Regression guard for the load-bearing ESM `__dirname`/`__filename`/`require`
// banner in bundle-tools.cjs (ESM_REQUIRE_BANNER).
//
// This PR made @argent/telemetry import @argent/native-devtools-ios, which
// computes its binary dir from a top-level `__dirname` at module init. esbuild
// inlines that CJS code into the ESM cli/mcp/installer bundles, which have no
// `__dirname` in ES module scope, so the banner shims it in. If the banner ever
// loses those lines, esbuild emits NO warning/error and no existing test loads a
// built ESM bundle, so the shipped CLI / MCP server / installer would crash at
// module init ("__dirname is not defined in ES module scope") with CI green.
//
// This reproduces that exact load path with the REAL banner (read from source,
// so it tracks any edit) against a self-contained CJS probe that reads __dirname
// at load. It is hermetic (needs no built artifacts) and loads the bundle in a
// REAL node subprocess — NOT vitest's import(), which injects its own __dirname
// and would mask the failure.

const workspaceRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const bundleToolsSrc = fs.readFileSync(
  path.join(workspaceRoot, "packages/argent/scripts/bundle-tools.cjs"),
  "utf8"
);

/** Extract the real ESM_REQUIRE_BANNER object literal from the build script. */
function readRealBanner(): string {
  const m = bundleToolsSrc.match(/const ESM_REQUIRE_BANNER = (\{[\s\S]*?\});/);
  if (!m) throw new Error("could not locate ESM_REQUIRE_BANNER in bundle-tools.cjs");
  // The literal references only string constants, so evaluating it in isolation
  // is safe and yields the exact banner esbuild injects into ESM bundles.
  return (eval(`(${m[1]})`) as { js: string }).js;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-banner-test-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// A CJS module mimicking native-devtools-ios/dist/index.js: it reads __dirname /
// __filename / require at module init. esbuild inlines CJS deps like this into
// the ESM bundles, so it exercises the exact scope the banner has to satisfy.
// Prints a marker on success; if __dirname is unshimmed it throws before the log.
const PROBE_CJS = `
const path = require("path");
const binDir = path.join(__dirname, "..", "bin");
process.stdout.write("PROBE_OK " + (typeof binDir) + " " + (typeof __filename) + " " + (typeof require) + "\\n");
module.exports = {};
`;

/** Bundle the probe to ESM with `banner`, run it in a real node process. */
function runProbeBundledWith(banner: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const entry = path.join(tmpDir, `probe-${crypto.randomUUID()}.cjs`);
  fs.writeFileSync(entry, PROBE_CJS);
  const built = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["node:*"],
    banner: { js: banner },
    write: false,
  });
  const outPath = path.join(tmpDir, `bundle-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(outPath, built.outputFiles[0]!.text);
  const res = spawnSync(process.execPath, [outPath], { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("ESM require banner (bundle-tools.cjs ESM_REQUIRE_BANNER)", () => {
  it("shims __dirname/__filename/require so a CJS dep reading them at init loads in a real ESM bundle", () => {
    const { status, stdout, stderr } = runProbeBundledWith(readRealBanner());
    expect(stderr).not.toMatch(/__dirname is not defined/);
    expect(status).toBe(0);
    // string __dirname join, string __filename, function require — the shim's contract.
    expect(stdout).toContain("PROBE_OK string string function");
  });

  it("catches a banner that drops the __dirname shim (proves the guard is not vacuous)", () => {
    // Negative control: the pre-PR banner (createRequire only). Without the
    // __dirname/__filename lines the same probe must crash at module init.
    const bannerWithoutDirname =
      "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";
    const { status, stderr } = runProbeBundledWith(bannerWithoutDirname);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/__dirname is not defined in ES module scope/);
  });
});
