import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getInstalledVersion,
  getGloballyInstalledVersion,
  detectPackageManager,
  globalInstallCommand,
  formatShellCommand,
} from "../src/utils.js";
import { getUpdateTriggerFromEnv, resolveUpdatePackageAction } from "../src/update.js";
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

describe("update — registry safety", () => {
  it("globalInstallCommand never includes --registry (relies on .npmrc scoped registry)", () => {
    for (const pm of ["npm", "yarn", "pnpm", "bun"] as const) {
      const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@1.0.0`);
      const cmdStr = formatShellCommand(cmd);
      expect(cmdStr).not.toContain("--registry");
    }
  });
});

describe("update — telemetry package action tagging", () => {
  it("distinguishes standalone update/install from MCP-triggered update", () => {
    expect(resolveUpdatePackageAction("update", "0.8.0")).toBe("standalone_update");
    expect(resolveUpdatePackageAction("update", null)).toBe("standalone_install");
    expect(resolveUpdatePackageAction("mcp_update", "0.8.0")).toBe("mcp_update");
  });

  it("reads only the supported MCP update trigger env enum", () => {
    expect(
      getUpdateTriggerFromEnv({ ARGENT_UPDATE_TRIGGER: "mcp_update" } as NodeJS.ProcessEnv)
    ).toBe("mcp_update");
    expect(
      getUpdateTriggerFromEnv({ ARGENT_UPDATE_TRIGGER: "https://internal" } as NodeJS.ProcessEnv)
    ).toBe("update");
    expect(getUpdateTriggerFromEnv({} as NodeJS.ProcessEnv)).toBe("update");
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
    // Returns the dir to put on PATH. The package.json must use the real
    // PACKAGE_NAME — getGloballyInstalledPackageRoot validates it so a stray
    // package.json can't scope tool-server teardown to an unrelated install.
    function stageInstall(root: string, version: string): string {
      const pkgRoot = path.join(root, "lib", "node_modules", PACKAGE_NAME);
      const distDir = path.join(pkgRoot, "dist");
      const binDir = path.join(root, "bin");
      fs.mkdirSync(distDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgRoot, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version, bin: { argent: "dist/cli.js" } })
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

    it("returns null when the walked-up package.json is NOT argent's", () => {
      // The walk-up lands on a non-argent package.json (e.g. a stray
      // ~/package.json); the name-validated probe must reject it rather than
      // report a version for an unrelated install.
      const binDir = path.join(tmpDir, "stray", "bin");
      const distDir = path.join(tmpDir, "stray", "lib", "node_modules", "not-argent", "dist");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, "..", "package.json"),
        JSON.stringify({ name: "not-argent", version: "9.9.9", bin: { argent: "dist/cli.js" } })
      );
      const cliPath = path.join(distDir, "cli.js");
      fs.writeFileSync(cliPath, "#!/usr/bin/env node\n");
      fs.chmodSync(cliPath, 0o755);
      fs.symlinkSync(cliPath, path.join(binDir, "argent"));
      process.env.PATH = `${binDir}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBeNull();
    });
  }
);

// A shim — pnpm's POSIX cmd-shim, or an npm/pnpm Windows .cmd — is a REGULAR
// file, not a symlink into the package: realpath + walk-up (exercised above)
// never crosses into it, which is #1207 (pnpm-installed `argent update`
// reporting "Could not determine installed version"). These exercise the
// shim-reading fallback the same end-to-end way, through the public function.
describe.skipIf(process.platform === "win32")(
  "update — getGloballyInstalledVersion against a shimmed install",
  () => {
    let tmpDir: string;
    let originalPath: string | undefined;

    const SYSTEM_PATH = `/usr/bin${path.delimiter}/bin`;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-installer-shim-test-"));
      originalPath = process.env.PATH;
    });

    afterEach(() => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // Stages a package (real package.json, given name) under `root` and
    // returns its dist/cli.js absolute path — the shim's target.
    function stagePackage(root: string, name: string, version: string): string {
      const pkgRoot = path.join(root, "global", "node_modules", "@swmansion", "argent");
      const distDir = path.join(pkgRoot, "dist");
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgRoot, "package.json"),
        JSON.stringify({ name, version, bin: { argent: "dist/cli.js" } })
      );
      const cliPath = path.join(distDir, "cli.js");
      fs.writeFileSync(cliPath, "#!/usr/bin/env node\n");
      return cliPath;
    }

    // Writes a REGULAR (non-symlink) executable file at <root>/bin/argent
    // with the given shim text, and returns the bin dir to put on PATH.
    function stageShim(root: string, contents: string): string {
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const binPath = path.join(binDir, "argent");
      fs.writeFileSync(binPath, contents);
      fs.chmodSync(binPath, 0o755);
      return binDir;
    }

    // The relative path a shim would embed, as forward slashes (POSIX) —
    // callers turn it into backslashes for the Windows fixtures.
    function relTarget(binDir: string, cliPath: string): string {
      return path.relative(binDir, cliPath).split(path.sep).join("/");
    }

    it("resolves a pnpm POSIX shim via its cmd-shim-target trailer", () => {
      const root = path.join(tmpDir, "install");
      const cliPath = stagePackage(root, PACKAGE_NAME, "3.1.4");
      const binDir = path.join(root, "bin");
      const rel = relTarget(binDir, cliPath);
      // Mirrors the real pnpm shim: several exec fallbacks, all pointing at
      // the same relative target, plus the trailing cmd-shim-target comment.
      const contents =
        `#!/bin/sh\n` +
        `basedir=$(dirname "$0")\n` +
        `case \`uname\` in\n  *CYGWIN*) basedir=\`cygpath -w "$basedir"\`;;\nesac\n\n` +
        `if [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/${rel}" "$@"\n` +
        `else\n  exec node  "$basedir/${rel}" "$@"\nfi\n` +
        `# cmd-shim-target=${cliPath}\n`;
      const binOnPath = stageShim(root, contents);
      process.env.PATH = `${binOnPath}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBe("3.1.4");
    });

    it("resolves a POSIX sh shim with no trailer, via $basedir", () => {
      const root = path.join(tmpDir, "install");
      const cliPath = stagePackage(root, PACKAGE_NAME, "2.0.0");
      const binDir = path.join(root, "bin");
      const rel = relTarget(binDir, cliPath);
      const contents = `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/${rel}" "$@"\n`;
      const binOnPath = stageShim(root, contents);
      process.env.PATH = `${binOnPath}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBe("2.0.0");
    });

    it("resolves a Windows .cmd shim using %dp0%\\", () => {
      const root = path.join(tmpDir, "install");
      const cliPath = stagePackage(root, PACKAGE_NAME, "4.5.6");
      const binDir = path.join(root, "bin");
      const relWin = relTarget(binDir, cliPath).split("/").join("\\");
      const contents = `@ECHO off\r\nnode  "%dp0%\\${relWin}" %*\r\n`;
      const binOnPath = stageShim(root, contents);
      process.env.PATH = `${binOnPath}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBe("4.5.6");
    });

    it("resolves a Windows .cmd shim using %~dp0\\", () => {
      const root = path.join(tmpDir, "install");
      const cliPath = stagePackage(root, PACKAGE_NAME, "7.8.9");
      const binDir = path.join(root, "bin");
      const relWin = relTarget(binDir, cliPath).split("/").join("\\");
      const contents = `@ECHO off\r\nnode  "%~dp0\\${relWin}" %*\r\n`;
      const binOnPath = stageShim(root, contents);
      process.env.PATH = `${binOnPath}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBe("7.8.9");
    });

    it("returns null for a shim script pointing somewhere unrelated", () => {
      const root = path.join(tmpDir, "install");
      // Valid $basedir shim shape, but the target isn't argent's package —
      // nothing here should be mistaken for it.
      const contents = `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../other-tool/dist/cli.js" "$@"\n`;
      const binOnPath = stageShim(root, contents);
      process.env.PATH = `${binOnPath}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBeNull();
    });

    it("returns null when the shim's target package.json has the wrong name", () => {
      const root = path.join(tmpDir, "install");
      // Same node_modules/@swmansion/argent/ shape the marker looks for, but
      // a spoofed package.json — must not be trusted as the real install.
      const cliPath = stagePackage(root, "not-argent", "9.9.9");
      const binDir = path.join(root, "bin");
      const rel = relTarget(binDir, cliPath);
      const contents = `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/${rel}" "$@"\n`;
      const binOnPath = stageShim(root, contents);
      process.env.PATH = `${binOnPath}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBeNull();
    });

    it("returns null for an oversized or NUL-containing bin file (not treated as a shim)", () => {
      const root = path.join(tmpDir, "install");
      stagePackage(root, PACKAGE_NAME, "1.0.0");
      const binDir = path.join(root, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const binPath = path.join(binDir, "argent");
      // A NUL byte anywhere in the file rules it out as a text shim, however
      // small — a real binary bin (e.g. a compiled launcher) could otherwise
      // be misread as one.
      fs.writeFileSync(binPath, Buffer.from(`#!/bin/sh\n\0exec node "$basedir/x" "$@"\n`));
      fs.chmodSync(binPath, 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${SYSTEM_PATH}`;

      expect(getGloballyInstalledVersion()).toBeNull();
    });
  }
);
