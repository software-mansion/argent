import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readWorkspaceSnapshot } from "../src/utils/workspace-reader";

/**
 * Integration test: builds a realistic React Native project directory tree and
 * validates the full readWorkspaceSnapshot output end-to-end.
 */

let projectDir: string;

async function writeJson(dir: string, name: string, data: unknown) {
  await writeFile(join(dir, name), JSON.stringify(data, null, 2));
}

async function writeText(path: string, content: string) {
  await writeFile(path, content);
}

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "rn-project-integration-"));

  // ── package.json ───────────────────────────────────────────────
  await writeJson(projectDir, "package.json", {
    name: "IntegrationTestApp",
    version: "2.1.0",
    scripts: {
      start: "react-native start",
      "start:local": "LOCAL_API=true react-native start",
      ios: "react-native run-ios",
      android: "react-native run-android",
      test: "jest",
      lint: "eslint .",
      "lint:fix": "eslint . --fix",
      tsc: "tsc --noEmit",
      format: "prettier --write .",
    },
    dependencies: {
      react: "18.2.0",
      "react-native": "0.74.2",
      "react-native-reanimated": "^3.8.0",
      "@react-navigation/native": "^6.1.9",
      zustand: "^4.5.0",
      "react-native-config": "^1.5.0",
    },
    devDependencies: {
      typescript: "^5.4.0",
      jest: "^29.7.0",
      eslint: "^8.57.0",
      prettier: "^3.2.0",
      "lint-staged": { "*.{ts,tsx}": ["eslint --fix", "prettier --write"] },
    },
    "lint-staged": {
      "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    },
  });

  // ── Metro config with custom port ──────────────────────────────
  await writeText(
    join(projectDir, "metro.config.js"),
    `const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const config = {
  server: {
    port: 8082,
  },
  transformer: {
    getTransformOptions: async () => ({
      transform: { experimentalImportSupport: false, inlineRequires: true },
    }),
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
`,
  );

  // ── Babel config ───────────────────────────────────────────────
  await writeText(
    join(projectDir, "babel.config.js"),
    `module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['react-native-reanimated/plugin'],
};
`,
  );

  // ── tsconfig.json ──────────────────────────────────────────────
  await writeJson(projectDir, "tsconfig.json", {
    compilerOptions: {
      strict: true,
      target: "esnext",
      module: "commonjs",
      jsx: "react-native",
      moduleResolution: "node",
    },
    include: ["src"],
  });

  // ── app.json ───────────────────────────────────────────────────
  await writeJson(projectDir, "app.json", {
    name: "IntegrationTestApp",
    displayName: "Integration Test App",
  });

  // ── eas.json ───────────────────────────────────────────────────
  await writeJson(projectDir, "eas.json", {
    build: {
      development: { distribution: "internal", ios: { simulator: true } },
      staging: { distribution: "internal" },
      production: {},
    },
  });

  // ── eslint config ──────────────────────────────────────────────
  await writeJson(projectDir, ".eslintrc.json", {
    extends: "@react-native",
    rules: { "no-console": "warn" },
  });

  // ── prettier config ────────────────────────────────────────────
  await writeJson(projectDir, ".prettierrc.json", {
    singleQuote: true,
    trailingComma: "all",
  });

  // ── jest config ────────────────────────────────────────────────
  await writeText(
    join(projectDir, "jest.config.js"),
    `module.exports = { preset: 'react-native', testPathIgnorePatterns: ['/node_modules/', '/e2e/'] };`,
  );

  // ── iOS directory ──────────────────────────────────────────────
  await mkdir(join(projectDir, "ios", "IntegrationTestApp.xcworkspace"), {
    recursive: true,
  });
  await writeText(
    join(projectDir, "ios", "Podfile"),
    `platform :ios, '14.0'\nuse_frameworks! :linkage => :static\n`,
  );

  // ── Android directory ──────────────────────────────────────────
  await mkdir(join(projectDir, "android", "app"), { recursive: true });
  await writeText(
    join(projectDir, "android", "build.gradle"),
    `buildscript { ext { buildToolsVersion = "34.0.0" } }`,
  );

  // ── Yarn lockfile ──────────────────────────────────────────────
  await writeText(join(projectDir, "yarn.lock"), "# yarn lockfile v1\n");

  // ── .env files ─────────────────────────────────────────────────
  await writeText(
    join(projectDir, ".env"),
    "API_URL=https://api.production.example.com\nANALYTICS_KEY=prod_key_123\n",
  );
  await writeText(
    join(projectDir, ".env.local"),
    "API_URL=http://localhost:3000\nDEBUG_MODE=true\n",
  );

  // ── Makefile ───────────────────────────────────────────────────
  await writeText(
    join(projectDir, "Makefile"),
    `setup:\n\tyarn install\n\tcd ios && pod install\n\nlint:\n\tyarn lint\n\ntest:\n\tyarn test\n\ntypecheck:\n\tyarn tsc\n`,
  );

  // ── scripts/ directory ─────────────────────────────────────────
  await mkdir(join(projectDir, "scripts"));
  await writeText(
    join(projectDir, "scripts", "seed-data.sh"),
    "#!/bin/bash\necho seeding",
  );
  await writeText(
    join(projectDir, "scripts", "migrate.js"),
    "// migration script",
  );

  // ── .husky/ directory ──────────────────────────────────────────
  await mkdir(join(projectDir, ".husky"));
  await writeText(
    join(projectDir, ".husky", "pre-commit"),
    "#!/usr/bin/env sh\nnpx lint-staged",
  );

  // ── GitHub Actions CI ──────────────────────────────────────────
  await mkdir(join(projectDir, ".github", "workflows"), { recursive: true });
  await writeText(
    join(projectDir, ".github", "workflows", "ci.yml"),
    "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
  );

  // ── .vscode/launch.json ────────────────────────────────────────
  await mkdir(join(projectDir, ".vscode"));
  await writeJson(join(projectDir, ".vscode"), "launch.json", {
    version: "0.2.0",
    configurations: [],
  });
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("workspace-reader integration (realistic RN project)", () => {
  it("returns all expected fields", async () => {
    const snap = await readWorkspaceSnapshot(projectDir);

    // Top-level workspace path
    expect(snap.workspace_path).toBe(projectDir);

    // package.json parsed correctly
    expect(snap.package_json).toBeDefined();
    expect(snap.package_json!.name).toBe("IntegrationTestApp");
    expect(snap.package_json!.version).toBe("2.1.0");
    const scripts = snap.package_json!.scripts as Record<string, string>;
    expect(scripts["start:local"]).toContain("LOCAL_API");

    // Metro config
    expect(snap.metro_config_raw).toContain("mergeConfig");
    expect(snap.metro_config_raw).toContain("port: 8082");
    expect(snap.metro_port).toBe(8082);

    // Babel config
    expect(snap.babel_config_raw).toContain("react-native-reanimated/plugin");

    // app.json
    expect(snap.app_json).toMatchObject({
      name: "IntegrationTestApp",
      displayName: "Integration Test App",
    });

    // eas.json
    expect(snap.eas_json).toBeDefined();
    expect(snap.eas_json!.build).toBeDefined();

    // tsconfig
    expect(snap.tsconfig).toBeDefined();
    expect(
      (snap.tsconfig!.compilerOptions as Record<string, unknown>).strict,
    ).toBe(true);

    // Platform directories
    expect(snap.has_ios_dir).toBe(true);
    expect(snap.has_android_dir).toBe(true);
    expect(snap.ios_workspace).toBe("IntegrationTestApp.xcworkspace");
    expect(snap.has_podfile).toBe(true);

    // Lockfile
    expect(snap.lockfile).toBe("yarn.lock");

    // .env files (keys only, no values)
    expect(snap.env_files).toHaveLength(2);
    const envMain = snap.env_files.find((e) => e.name === ".env")!;
    expect(envMain.keys).toContain("API_URL");
    expect(envMain.keys).toContain("ANALYTICS_KEY");
    const envLocal = snap.env_files.find((e) => e.name === ".env.local")!;
    expect(envLocal.keys).toContain("API_URL");
    expect(envLocal.keys).toContain("DEBUG_MODE");

    // Verify no secrets leaked
    const serialized = JSON.stringify(snap.env_files);
    expect(serialized).not.toContain("prod_key_123");
    expect(serialized).not.toContain("https://api.production.example.com");
    expect(serialized).not.toContain("http://localhost:3000");

    // Tool versions
    expect(snap.tool_versions).toHaveProperty("node");
    expect(snap.tool_versions.node).toBeTruthy();

    // scripts/ directory
    expect(snap.scripts_dir_entries).toContain("seed-data.sh");
    expect(snap.scripts_dir_entries).toContain("migrate.js");

    // .husky/ hooks
    expect(snap.husky_hooks).toContain("pre-commit");

    // CI config
    expect(snap.ci_config).toBe("github-actions");

    // Makefile targets
    expect(snap.makefile_targets).toEqual(
      expect.arrayContaining(["setup", "lint", "test", "typecheck"]),
    );

    // lint-staged config
    expect(snap.lint_staged_config).toEqual({
      "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    });

    // Config files found
    expect(snap.config_files_found).toEqual(
      expect.arrayContaining([
        "metro.config.js",
        "babel.config.js",
        "tsconfig.json",
        "app.json",
        "eas.json",
        ".eslintrc.json",
        "jest.config.js",
        "Makefile",
        ".vscode/launch.json",
      ]),
    );
  });

  it("completes in under 5 seconds", async () => {
    const start = performance.now();
    await readWorkspaceSnapshot(projectDir);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5_000);
  });
});
