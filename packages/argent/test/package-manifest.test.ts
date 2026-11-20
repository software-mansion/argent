import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import semver from "semver";
import { describe, expect, it } from "vitest";

describe("package manifest", () => {
  it("publishes the bundled native dylibs and runtime artifacts", () => {
    const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { files?: string[] };

    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("dylibs/");
    expect(pkg.files).toContain("bin/");
    expect(pkg.files).toContain("skills/");
  });

  it("admits only Node releases that run TypeScript and have zstd, in both published packages", () => {
    const engines = (dir: string) =>
      (
        JSON.parse(
          fs.readFileSync(
            path.resolve(import.meta.dirname, "..", "..", dir, "package.json"),
            "utf8"
          )
        ) as { engines: { node: string } }
      ).engines.node;
    const range = engines("argent");

    expect(engines("argent-alias")).toBe(range);
    // Node runs TypeScript with no flag from 22.18.0 and 23.6.0, which a
    // `script:` step of an e2e test needs. zstd in node:zlib landed in 22.15.0
    // and 23.8.0.
    for (const v of ["22.18.0", "22.99.0", "23.8.0", "24.0.0", "26.0.0"]) {
      expect(semver.satisfies(v, range), v).toBe(true);
    }
    for (const v of ["20.19.0", "22.14.0", "22.17.1", "23.0.0", "23.7.0"]) {
      expect(semver.satisfies(v, range), v).toBe(false);
    }
  });

  it("exports the client and keeps deep paths resolvable", () => {
    const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      exports?: Record<string, unknown>;
    };

    expect(pkg.exports?.["./client"]).toEqual({
      types: "./dist/client.d.ts",
      default: "./dist/client.js",
    });
    // The `argent` alias package resolves `@swmansion/argent/dist/cli.js`.
    expect(pkg.exports?.["./*"]).toBe("./*");
  });

  it("resolves every extensionless deep path that 0.26.0 resolved", () => {
    // Before the exports map, require() probed `.js`/`.json`, and bundlers and
    // Bun also `.mjs`/`.cjs`/`.css`; an exports map resolves only the keys it
    // lists, so each of these needs its own.
    const extensionless: Record<string, string> = {
      "assets/manifest": "assets/manifest.json",
      "assets/trace-processor/engine_bundle.node": "assets/trace-processor/engine_bundle.node.js",
      "bin/argent-simulator-server": "bin/argent-simulator-server.cjs",
      "dist/bundled-paths": "dist/bundled-paths.js",
      "dist/cli": "dist/cli.js",
      "dist/cli-cmds": "dist/cli-cmds.mjs",
      "dist/fatal-handlers": "dist/fatal-handlers.js",
      "dist/flow-script-runner": "dist/flow-script-runner.mjs",
      "dist/flow-script-watchdog-deadline": "dist/flow-script-watchdog-deadline.mjs",
      "dist/flow-script-watchdog-lifeline": "dist/flow-script-watchdog-lifeline.mjs",
      "dist/installer": "dist/installer.mjs",
      "dist/installer-help": "dist/installer-help.js",
      "dist/mcp-server": "dist/mcp-server.mjs",
      "dist/preview-ui/theme": "dist/preview-ui/theme.css",
      "dist/preview-window/main": "dist/preview-window/main.cjs",
      "dist/tool-server": "dist/tool-server.cjs",
      "package": "package.json",
    };
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-exports-")));
    try {
      const pkgDir = path.join(root, "node_modules", "@swmansion", "argent");
      for (const file of [...Object.values(extensionless), "dist/client.js"]) {
        fs.mkdirSync(path.dirname(path.join(pkgDir, file)), { recursive: true });
        fs.writeFileSync(path.join(pkgDir, file), "");
      }
      fs.copyFileSync(
        path.resolve(import.meta.dirname, "..", "package.json"),
        path.join(pkgDir, "package.json")
      );
      const require = createRequire(path.join(root, "index.js"));

      for (const [spec, file] of Object.entries(extensionless)) {
        expect(require.resolve(`@swmansion/argent/${spec}`)).toBe(path.join(pkgDir, file));
        expect(require.resolve(`@swmansion/argent/${file}`)).toBe(path.join(pkgDir, file));
      }
      expect(require.resolve("@swmansion/argent/client")).toBe(
        path.join(pkgDir, "dist", "client.js")
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
