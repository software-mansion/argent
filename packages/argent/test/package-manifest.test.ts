import * as fs from "node:fs";
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
