import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getInstalledVersion,
  getGloballyInstalledVersion,
  detectPackageManager,
  globalInstallCommand,
  formatShellCommand,
  isTempRunnerPath,
} from "../src/utils.js";
import { PACKAGE_NAME, NPM_REGISTRY } from "../src/constants.js";

describe("update — version comparison logic", () => {
  it("getInstalledVersion returns a semver-like string or null", () => {
    const version = getInstalledVersion();
    // In the test environment this reads the package.json from the dist/..
    // directory which may not exist; either way the function should not throw.
    expect(version === null || /^\d+\.\d+\.\d+/.test(version)).toBe(true);
  });

  it("getGloballyInstalledVersion returns a semver-like string or null", () => {
    // Test envs may or may not have a global argent install; either result
    // is acceptable as long as the call doesn't throw and the shape is
    // valid. The point of this helper is to NOT confuse the running
    // (possibly npx-cached) version with the persisted global one.
    const version = getGloballyInstalledVersion();
    expect(version === null || /^\d+\.\d+\.\d+/.test(version)).toBe(true);
  });
});

describe("update — install command generation", () => {
  const original = process.env.npm_config_user_agent;

  afterEach(() => {
    if (original === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = original;
  });

  it("generates correct npm update command without --registry", () => {
    delete process.env.npm_config_user_agent;
    const pm = detectPackageManager();
    const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@1.0.0`);
    const cmdStr = formatShellCommand(cmd);
    expect(cmdStr).toContain("npm install -g");
    expect(cmdStr).toContain(PACKAGE_NAME);
    expect(cmdStr).not.toContain("--registry");
  });

  it("generates correct pnpm update command", () => {
    process.env.npm_config_user_agent = "pnpm/9.0.0";
    const pm = detectPackageManager();
    const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@1.0.0`);
    const cmdStr = formatShellCommand(cmd);
    expect(cmdStr).toContain("pnpm add -g");
    expect(cmdStr).toContain(PACKAGE_NAME);
  });
});

describe("update — constants are correct", () => {
  it("PACKAGE_NAME is @swmansion/argent", () => {
    expect(PACKAGE_NAME).toBe("@swmansion/argent");
  });

  it("NPM_REGISTRY is the npm registry", () => {
    expect(NPM_REGISTRY).toContain("registry.npmjs.org");
  });
});

describe("update — temp runner detection", () => {
  // npx-cached argent shares the latest version, so without this filter the
  // version compare would falsely match latest after the user uninstalled the
  // global package via `npx @swmansion/argent uninstall`.
  it("flags npx cache paths as transient", () => {
    expect(isTempRunnerPath("/Users/me/.npm/_npx/abc123/node_modules/.bin/argent")).toBe(true);
  });

  it("flags pnpm dlx cache paths as transient", () => {
    expect(isTempRunnerPath("/Users/me/.pnpm-store/dlx-1234/node_modules/.bin/argent")).toBe(true);
  });

  it("flags bun install cache paths as transient", () => {
    expect(isTempRunnerPath("/Users/me/.bun/install/cache/argent")).toBe(true);
  });

  it("flags Windows dlx cache paths as transient", () => {
    expect(isTempRunnerPath("C:\\Users\\me\\AppData\\Local\\dlx-abc\\argent.cmd")).toBe(true);
  });

  it("treats real global install paths as permanent", () => {
    expect(isTempRunnerPath("/usr/local/bin/argent")).toBe(false);
    expect(isTempRunnerPath("/opt/homebrew/bin/argent")).toBe(false);
    expect(isTempRunnerPath("C:\\Users\\me\\AppData\\Roaming\\npm\\argent.cmd")).toBe(false);
  });
});

describe("update — registry safety", () => {
  it("globalInstallCommand never includes --registry (relies on .npmrc scoped registry)", () => {
    for (const pm of ["npm", "yarn", "pnpm", "bun"] as const) {
      const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@1.0.0`);
      const cmdStr = formatShellCommand(cmd);
      expect(cmdStr).not.toContain("--registry");
    }
  });
});

// These exercise getGloballyInstalledVersion against a real on-disk install
// layout (binary symlinked into a node_modules/<pkg>/ directory tree) rather
// than mocking. That way we actually validate the bug fix end-to-end:
//   which/where -> realpath -> walk up to package.json -> read version.
// Skipped on Windows because creating fs symlinks there needs admin rights
// (or developer mode), which isn't reliable in CI.
describe.skipIf(process.platform === "win32")(
  "update — getGloballyInstalledVersion against a staged install",
  () => {
    let tmpDir: string;
    let originalPath: string | undefined;

    // Narrow PATH to system dirs so `which` itself stays reachable while
    // hiding any real argent install on the dev machine. /usr/bin and /bin
    // do not contain argent on any standard Unix layout (npm/pnpm/yarn/brew
    // all install elsewhere), so a real binary cannot leak into the result.
    const SYSTEM_PATH = `/usr/bin${path.delimiter}/bin`;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-installer-test-"));
      originalPath = process.env.PATH;
    });

    afterEach(() => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // Mimics the layout npm/pnpm/yarn produce for a global install — a bin
    // entry that is a symlink into <prefix>/lib/node_modules/<pkg>/dist/.
    // Returns the dir to put on PATH. The package name is irrelevant: the
    // helper resolves the symlink and walks up to the first package.json,
    // which is what matters for the bug we're guarding against.
    function stageInstall(root: string, version: string): string {
      const pkgRoot = path.join(root, "lib", "node_modules", "fake-argent");
      const distDir = path.join(pkgRoot, "dist");
      const binDir = path.join(root, "bin");
      fs.mkdirSync(distDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgRoot, "package.json"),
        JSON.stringify({ name: "fake-argent", version, bin: { argent: "dist/cli.js" } })
      );
      const cliPath = path.join(distDir, "cli.js");
      fs.writeFileSync(cliPath, "#!/usr/bin/env node\n");
      fs.chmodSync(cliPath, 0o755);
      fs.symlinkSync(cliPath, path.join(binDir, "argent"));
      return binDir;
    }

    it("reads the version from the actual global package.json, not PACKAGE_ROOT", () => {
      // This is the headline regression: even when invoked from npx (where
      // PACKAGE_ROOT is the latest published version), the function must
      // report the version of the binary that's actually on PATH.
      const binDir = stageInstall(tmpDir, "9.9.9");
      process.env.PATH = `${binDir}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBe("9.9.9");
    });

    it("skips an npx-style transient install ahead of the permanent one on PATH", () => {
      // Simulates: npx caches latest argent, user has an older global
      // install. Without the temp-runner filter `which -a` returns the
      // cache first and we'd report "latest" — masking the outdated global.
      const transientBin = stageInstall(path.join(tmpDir, "cache", "_npx", "abc123"), "0.0.1");
      const persistentBin = stageInstall(path.join(tmpDir, "persistent"), "9.9.9");
      // Transient first so a naive "first match" would pick it.
      process.env.PATH = [transientBin, persistentBin, SYSTEM_PATH].join(path.delimiter);

      expect(getGloballyInstalledVersion()).toBe("9.9.9");
    });

    it("returns null when no permanent install is on PATH", () => {
      const emptyBinDir = path.join(tmpDir, "empty-bin");
      fs.mkdirSync(emptyBinDir);
      process.env.PATH = `${emptyBinDir}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBeNull();
    });

    it("returns null when only a transient runner has argent on PATH", () => {
      // No permanent install — only an npx-style cache. This is the
      // "running via npx with no global ever installed" case; the function
      // must NOT fall back to reporting the transient version.
      const transientBin = stageInstall(path.join(tmpDir, "cache", "_npx", "xyz"), "1.2.3");
      process.env.PATH = `${transientBin}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBeNull();
    });
  }
);
