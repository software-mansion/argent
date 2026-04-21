import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Stub child_process.execFile so tool-version detection does not spawn
// 8 real subprocesses per snapshot — that was the dominant per-test cost
// (~250ms × 18 tests). The returned string is shaped like `node --version`
// output so downstream parsing (strip leading "v") stays exercised.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      _cmd: string,
      _args: readonly string[] | undefined,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      queueMicrotask(() => cb(null, "v0.0.0\n", ""));
      return { on: () => {} } as unknown as ReturnType<typeof actual.execFile>;
    },
  };
});

import {
  readWorkspaceSnapshot,
  extractMetroPort,
  extractEnvKeys,
  extractMakefileTargets,
} from "../src/utils/workspace-reader";

// ── Temp directory helpers ───────────────────────────────────────────

let tempDir: string;

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ws-reader-test-"));
}

async function writeJson(dir: string, name: string, data: unknown) {
  await writeFile(join(dir, name), JSON.stringify(data, null, 2));
}

async function writeText(dir: string, name: string, content: string) {
  await writeFile(join(dir, name), content);
}

async function mkdirIn(dir: string, ...segments: string[]) {
  await mkdir(join(dir, ...segments), { recursive: true });
}

// ── Pure function tests ──────────────────────────────────────────────

describe("extractMetroPort", () => {
  it("extracts port from server config block", () => {
    const config = `module.exports = {
      server: { port: 9090 },
    };`;
    expect(extractMetroPort(config)).toBe(9090);
  });

  it("extracts port from multiline server block", () => {
    const config = `module.exports = {
      server: {
        enhanceMiddleware: () => {},
        port: 3000,
      },
    };`;
    expect(extractMetroPort(config)).toBe(3000);
  });

  it("extracts standalone port field", () => {
    const config = `module.exports = { port: 8082 };`;
    expect(extractMetroPort(config)).toBe(8082);
  });

  it("returns null when no port", () => {
    const config = `module.exports = { resolver: {} };`;
    expect(extractMetroPort(config)).toBeNull();
  });

  it("returns null for out-of-range port", () => {
    const config = `module.exports = { port: 99999 };`;
    expect(extractMetroPort(config)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractMetroPort("")).toBeNull();
  });
});

describe("extractEnvKeys", () => {
  it("extracts keys from standard .env content", () => {
    const content = `API_URL=https://example.com
SECRET_KEY=abc123
DATABASE_URL=postgres://...`;
    expect(extractEnvKeys(content)).toEqual(["API_URL", "SECRET_KEY", "DATABASE_URL"]);
  });

  it("skips comments and empty lines", () => {
    const content = `# This is a comment
API_URL=https://example.com

# Another comment
SECRET=value`;
    expect(extractEnvKeys(content)).toEqual(["API_URL", "SECRET"]);
  });

  it("handles keys with underscores and numbers", () => {
    const content = `REACT_APP_API_V2=something`;
    expect(extractEnvKeys(content)).toEqual(["REACT_APP_API_V2"]);
  });

  it("returns empty array for empty content", () => {
    expect(extractEnvKeys("")).toEqual([]);
  });

  it("does not return values", () => {
    const content = `SECRET=super_secret_value_123`;
    const keys = extractEnvKeys(content);
    expect(keys).toEqual(["SECRET"]);
    expect(keys.join("")).not.toContain("super_secret_value_123");
  });
});

describe("extractMakefileTargets", () => {
  it("extracts simple targets", () => {
    const content = `setup:
\t@echo "setup"

lint:
\t@yarn lint

test:
\t@yarn test`;
    expect(extractMakefileTargets(content)).toEqual(["setup", "lint", "test"]);
  });

  it("handles targets with hyphens and dots", () => {
    const content = `build-ios:
\t@echo building

deploy.staging:
\t@echo deploying`;
    expect(extractMakefileTargets(content)).toEqual(["build-ios", "deploy.staging"]);
  });

  it("returns empty array for empty content", () => {
    expect(extractMakefileTargets("")).toEqual([]);
  });
});

// ── Snapshot tests ───────────────────────────────────────────────────

describe("readWorkspaceSnapshot", () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns correct snapshot for a minimal RN project", async () => {
    await writeJson(tempDir, "package.json", {
      name: "TestApp",
      version: "1.0.0",
      dependencies: { "react-native": "0.74.0", "react": "18.2.0" },
      scripts: { start: "react-native start", ios: "react-native run-ios" },
    });
    await writeText(
      tempDir,
      "metro.config.js",
      `const {getDefaultConfig} = require('@react-native/metro-config');
module.exports = getDefaultConfig(__dirname);`
    );
    await mkdirIn(tempDir, "ios");
    await writeFile(join(tempDir, "ios", "Podfile"), "platform :ios, '13.4'");
    await mkdirIn(tempDir, "android");
    await writeFile(join(tempDir, "yarn.lock"), "# yarn lockfile v1");

    const snap = await readWorkspaceSnapshot(tempDir);

    expect(snap.workspace_path).toBe(tempDir);
    expect(snap.package_json).toMatchObject({ name: "TestApp" });
    expect(snap.metro_config_raw).toContain("getDefaultConfig");
    expect(snap.has_ios_dir).toBe(true);
    expect(snap.has_android_dir).toBe(true);
    expect(snap.has_podfile).toBe(true);
    expect(snap.lockfile).toBe("yarn.lock");
    expect(snap.config_files_found).toContain("metro.config.js");
  });

  it("returns correct snapshot for an Expo project", async () => {
    await writeJson(tempDir, "package.json", {
      name: "ExpoApp",
      dependencies: { expo: "~51.0.0", react: "18.2.0" },
    });
    await writeJson(tempDir, "app.json", {
      expo: { name: "ExpoApp", slug: "expo-app" },
    });

    const snap = await readWorkspaceSnapshot(tempDir);

    expect(snap.package_json).toMatchObject({ name: "ExpoApp" });
    expect(snap.app_json).toMatchObject({ expo: { name: "ExpoApp" } });
    expect(snap.has_ios_dir).toBe(false);
    expect(snap.has_android_dir).toBe(false);
    expect(snap.metro_config_raw).toBeNull();
  });

  it("handles an empty directory gracefully", async () => {
    const snap = await readWorkspaceSnapshot(tempDir);

    expect(snap.workspace_path).toBe(tempDir);
    expect(snap.package_json).toBeNull();
    expect(snap.metro_config_raw).toBeNull();
    expect(snap.app_json).toBeNull();
    expect(snap.eas_json).toBeNull();
    expect(snap.tsconfig).toBeNull();
    expect(snap.babel_config_raw).toBeNull();
    expect(snap.metro_port).toBeNull();
    expect(snap.has_ios_dir).toBe(false);
    expect(snap.has_android_dir).toBe(false);
    expect(snap.ios_workspace).toBeNull();
    expect(snap.has_podfile).toBe(false);
    expect(snap.lockfile).toBeNull();
    expect(snap.env_files).toEqual([]);
    expect(snap.scripts_dir_entries).toBeNull();
    expect(snap.husky_hooks).toBeNull();
    expect(snap.ci_config).toBeNull();
    expect(snap.makefile_targets).toBeNull();
    expect(snap.lint_staged_config).toBeNull();
    expect(snap.config_files_found).toEqual([]);
  });

  it("extracts metro port from config", async () => {
    await writeText(tempDir, "metro.config.js", `module.exports = { server: { port: 9090 } };`);

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.metro_port).toBe(9090);
  });

  it("detects .env files and extracts only keys", async () => {
    await writeText(tempDir, ".env", "API_URL=https://prod.example.com\nSECRET=s3cret");
    await writeText(tempDir, ".env.local", "LOCAL_API=http://localhost:3000");

    const snap = await readWorkspaceSnapshot(tempDir);

    expect(snap.env_files).toHaveLength(2);
    const envMain = snap.env_files.find((e) => e.name === ".env");
    const envLocal = snap.env_files.find((e) => e.name === ".env.local");
    expect(envMain?.keys).toEqual(["API_URL", "SECRET"]);
    expect(envLocal?.keys).toEqual(["LOCAL_API"]);

    const allContent = JSON.stringify(snap.env_files);
    expect(allContent).not.toContain("s3cret");
    expect(allContent).not.toContain("https://prod.example.com");
  });

  it("detects iOS workspace file", async () => {
    await mkdirIn(tempDir, "ios");
    await mkdirIn(tempDir, "ios", "MyApp.xcworkspace");

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.has_ios_dir).toBe(true);
    expect(snap.ios_workspace).toBe("MyApp.xcworkspace");
  });

  it("detects EAS config", async () => {
    await writeJson(tempDir, "eas.json", {
      build: {
        development: { distribution: "internal" },
        production: {},
      },
    });

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.eas_json).toMatchObject({
      build: { development: { distribution: "internal" } },
    });
    expect(snap.config_files_found).toContain("eas.json");
  });

  it("detects scripts directory", async () => {
    await mkdirIn(tempDir, "scripts");
    await writeText(join(tempDir, "scripts"), "seed-data.sh", "#!/bin/bash");
    await writeText(join(tempDir, "scripts"), "migrate.js", "// migrate");

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.scripts_dir_entries).toContain("seed-data.sh");
    expect(snap.scripts_dir_entries).toContain("migrate.js");
  });

  it("detects husky hooks", async () => {
    await mkdirIn(tempDir, ".husky");
    await writeText(join(tempDir, ".husky"), "pre-commit", "npx lint-staged");

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.husky_hooks).toContain("pre-commit");
  });

  it("detects CI config — GitHub Actions", async () => {
    await mkdirIn(tempDir, ".github", "workflows");

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.ci_config).toBe("github-actions");
  });

  it("detects Makefile targets", async () => {
    await writeText(tempDir, "Makefile", `setup:\n\t@echo setup\nlint:\n\t@yarn lint\n`);

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.makefile_targets).toEqual(["setup", "lint"]);
    expect(snap.config_files_found).toContain("Makefile");
  });

  it("detects lint-staged config from package.json", async () => {
    await writeJson(tempDir, "package.json", {
      "name": "test",
      "lint-staged": { "*.ts": ["eslint --fix", "prettier --write"] },
    });

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.lint_staged_config).toEqual({
      "*.ts": ["eslint --fix", "prettier --write"],
    });
  });

  it("detects lint-staged config from standalone file", async () => {
    await writeJson(tempDir, ".lintstagedrc.json", {
      "*.js": "eslint --fix",
    });

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.lint_staged_config).toEqual({ "*.js": "eslint --fix" });
  });

  it("detects all lockfile types", async () => {
    for (const lockName of ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"] as const) {
      const dir = await createTempDir();
      await writeText(dir, lockName, "");
      const snap = await readWorkspaceSnapshot(dir);
      expect(snap.lockfile).toBe(lockName);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects tool versions (node at minimum)", async () => {
    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.tool_versions).toHaveProperty("node");
    // Node should be available in the test environment
    expect(snap.tool_versions.node).toBeTruthy();
  });

  it("detects tsconfig.json", async () => {
    await writeJson(tempDir, "tsconfig.json", {
      compilerOptions: { strict: true },
    });

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.tsconfig).toMatchObject({
      compilerOptions: { strict: true },
    });
    expect(snap.config_files_found).toContain("tsconfig.json");
  });

  it("falls back to metro.config.ts if .js not found", async () => {
    await writeText(tempDir, "metro.config.ts", `export default { server: { port: 7777 } };`);

    const snap = await readWorkspaceSnapshot(tempDir);
    expect(snap.metro_config_raw).toContain("port: 7777");
    expect(snap.metro_port).toBe(7777);
  });
});
