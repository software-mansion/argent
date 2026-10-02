import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
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
      "assets/trace-processor/engine": "assets/trace-processor/engine.mjs",
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

// Regression guard for the ax-service-missing-from-release bug (first shipped
// in 0.9.0). The Linux-support layout migration (#249) moved the ax-service
// lookup to the per-platform `bin/<platform>/` directory — `axServiceBinaryPath()`
// resolves `bin/darwin/ax-service` and `bundle-tools.cjs` copies the published
// binary FROM `bin/darwin/ax-service` — but `download-native-binaries.sh` (the
// path the standard `pack`/CI release uses) kept writing the downloaded binary
// to the flat `bin/` root. The producer and consumer disagreed, so the bundler
// found nothing under darwin/, skipped the copy with only a warning, and every
// release silently shipped without ax-service. `describe`'s primary path then
// failed and fell back to native-devtools (or an empty tree), with a misleading
// "not booted through argent" hint. This test pins the producer→consumer path
// agreement so the two can never drift apart again.
describe("ax-service native-binary placement (producer/consumer path agreement)", () => {
  const workspaceRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const downloadScript = fs.readFileSync(
    path.join(workspaceRoot, "scripts/download-native-binaries.sh"),
    "utf8"
  );
  const bundleTools = fs.readFileSync(
    path.join(workspaceRoot, "packages/argent/scripts/bundle-tools.cjs"),
    "utf8"
  );

  // Resolve a `FOO="..."` shell assignment, expanding any ${VARS} already known.
  function shVar(src: string, name: string, known: Record<string, string>): string {
    const m = src.match(new RegExp(`^${name}="([^"]*)"`, "m"));
    if (!m) throw new Error(`assignment ${name}=... not found`);
    return m[1].replace(/\$\{(\w+)\}/g, (_, v) => {
      if (!(v in known)) throw new Error(`unknown var ${v} while expanding ${name}`);
      return known[v];
    });
  }

  it("download-native-binaries.sh writes ax-service into bin/darwin/, matching bundle-tools.cjs", () => {
    // Producer: where the release-download script puts ax-service.
    const BIN_DIR = shVar(downloadScript, "BIN_DIR", {});
    const IOS_BIN_DIR = shVar(downloadScript, "IOS_BIN_DIR", { BIN_DIR });
    // The ax-service download block must target IOS_BIN_DIR, not the flat root.
    const axBlock = downloadScript.slice(downloadScript.indexOf('--pattern "ax-service"'));
    const dirMatch = axBlock.match(/--dir "\$\{(\w+)\}"/);
    expect(dirMatch?.[1]).toBe("IOS_BIN_DIR");
    const producerDir = IOS_BIN_DIR; // packages/native-devtools-ios/bin/darwin

    // Consumer: where bundle-tools copies the published binary FROM.
    const binSrcRoot = bundleTools.match(/BIN_SRC_ROOT = path\.resolve\([^,]+,\s*"([^"]+)"\)/)?.[1];
    const axSrcRel = bundleTools.match(
      /AX_BIN_SRC = path\.resolve\(BIN_SRC_ROOT,\s*"([^"]+)"\)/
    )?.[1];
    expect(binSrcRoot).toBe("packages/native-devtools-ios/bin");
    expect(axSrcRel).toBe("darwin/ax-service");
    const consumerFile = path.posix.join(binSrcRoot!, axSrcRel!);

    // The two MUST agree: producer dir + ax-service === consumer source file.
    expect(path.posix.join(producerDir, "ax-service")).toBe(consumerFile);
    expect(producerDir.endsWith("/darwin")).toBe(true);
  });
});
