import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getInstalledVersion,
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
