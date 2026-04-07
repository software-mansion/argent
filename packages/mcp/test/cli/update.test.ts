import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getInstalledVersion,
  detectPackageManager,
  globalInstallCommand,
} from "../../src/cli/utils.js";
import { PACKAGE_NAME, NPM_REGISTRY } from "../../src/cli/constants.js";

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
    expect(cmd).toContain("npm install -g");
    expect(cmd).toContain(PACKAGE_NAME);
    expect(cmd).not.toContain("--registry");
  });

  it("generates correct pnpm update command", () => {
    process.env.npm_config_user_agent = "pnpm/9.0.0";
    const pm = detectPackageManager();
    const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@1.0.0`);
    expect(cmd).toContain("pnpm add -g");
    expect(cmd).toContain(PACKAGE_NAME);
  });
});

describe("update — constants are correct", () => {
  it("PACKAGE_NAME is @swmansion/argent", () => {
    expect(PACKAGE_NAME).toBe("@swmansion/argent");
  });

  it("NPM_REGISTRY is the GitHub packages registry", () => {
    expect(NPM_REGISTRY).toContain("npm.pkg.github.com");
  });
});

describe("update — registry safety", () => {
  it("globalInstallCommand never includes --registry (relies on .npmrc scoped registry)", () => {
    for (const pm of ["npm", "yarn", "pnpm", "bun"] as const) {
      const cmd = globalInstallCommand(pm, `${PACKAGE_NAME}@1.0.0`);
      expect(cmd).not.toContain("--registry");
    }
  });
});
