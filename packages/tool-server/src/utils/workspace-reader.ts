import { readFile, readdir, stat, access } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────

export interface EnvFileInfo {
  name: string;
  keys: string[];
}

export interface WorkspaceSnapshot {
  workspace_path: string;

  package_json: Record<string, unknown> | null;
  metro_config_raw: string | null;
  app_json: Record<string, unknown> | null;
  eas_json: Record<string, unknown> | null;
  tsconfig: Record<string, unknown> | null;
  babel_config_raw: string | null;

  metro_port: number | null;

  has_ios_dir: boolean;
  has_android_dir: boolean;
  ios_workspace: string | null;
  ios_has_podfile: boolean;
  android_has_gradle: boolean;

  lockfile: "yarn.lock" | "package-lock.json" | "pnpm-lock.yaml" | "bun.lockb" | "bun.lock" | null;

  env_files: EnvFileInfo[];

  tool_versions: Record<string, string | null>;

  scripts_dir_entries: string[] | null;
  husky_hooks: string[] | null;
  ci_config: string | null;
  makefile_targets: string[] | null;
  lint_staged_config: Record<string, unknown> | string | null;

  config_files_found: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function listDir(path: string): Promise<string[] | null> {
  try {
    const entries = await readdir(path);
    return entries;
  } catch {
    return null;
  }
}

const COMMAND_TIMEOUT_MS = 3_000;

export function runVersionCommand(
  cmd: string,
  args: string[],
  cwd: string
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: COMMAND_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.trim().replace(/^v/, ""));
    });
    child.on("error", () => resolve(null));
  });
}

// ── Metro port extraction ────────────────────────────────────────────

const METRO_PORT_PATTERNS = [/server\s*:\s*\{[^}]*?port\s*:\s*(\d+)/s, /port\s*:\s*(\d+)/];

export function extractMetroPort(configText: string): number | null {
  for (const pattern of METRO_PORT_PATTERNS) {
    const match = configText.match(pattern);
    if (match?.[1]) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port < 65536) return port;
    }
  }
  return null;
}

// ── .env key extraction ──────────────────────────────────────────────

export function extractEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        keys.push(key);
      }
    }
  }
  return keys;
}

// ── Makefile target extraction ───────────────────────────────────────

export function extractMakefileTargets(content: string): string[] {
  const targets: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_.-]*):/);
    if (match?.[1]) targets.push(match[1]);
  }
  return targets;
}

// ── Lockfile detection ───────────────────────────────────────────────

const LOCKFILES = [
  "yarn.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
] as const;

type LockfileName = (typeof LOCKFILES)[number];

async function detectLockfile(workspacePath: string): Promise<LockfileName | null> {
  const checks = await Promise.all(
    LOCKFILES.map(async (name) => ({
      name,
      exists: await exists(join(workspacePath, name)),
    }))
  );
  return checks.find((c) => c.exists)?.name ?? null;
}

// ── iOS workspace detection ──────────────────────────────────────────

async function findIosWorkspace(iosDir: string): Promise<string | null> {
  const entries = await listDir(iosDir);
  if (!entries) return null;
  const ws = entries.find((e) => e.endsWith(".xcworkspace"));
  return ws ?? null;
}

// ── CI config detection ──────────────────────────────────────────────

const CI_CONFIGS = [
  { path: ".github/workflows", label: "github-actions" },
  { path: ".circleci/config.yml", label: "circleci" },
  { path: "bitrise.yml", label: "bitrise" },
  { path: ".gitlab-ci.yml", label: "gitlab-ci" },
] as const;

async function detectCiConfig(workspacePath: string): Promise<string | null> {
  for (const ci of CI_CONFIGS) {
    if (await exists(join(workspacePath, ci.path))) return ci.label;
  }
  return null;
}

// ── lint-staged config ───────────────────────────────────────────────

const LINT_STAGED_FILES = [
  ".lintstagedrc",
  ".lintstagedrc.json",
  ".lintstagedrc.yaml",
  ".lintstagedrc.yml",
  ".lintstagedrc.js",
  ".lintstagedrc.cjs",
  ".lintstagedrc.mjs",
  "lint-staged.config.js",
  "lint-staged.config.cjs",
  "lint-staged.config.mjs",
];

async function detectLintStagedConfig(
  workspacePath: string,
  packageJson: Record<string, unknown> | null
): Promise<Record<string, unknown> | string | null> {
  if (packageJson && typeof packageJson === "object" && "lint-staged" in packageJson) {
    return packageJson["lint-staged"] as Record<string, unknown>;
  }
  for (const file of LINT_STAGED_FILES) {
    const full = join(workspacePath, file);
    if (await exists(full)) {
      if (file.endsWith(".json") || file === ".lintstagedrc") {
        return readJsonFile(full);
      }
      return file;
    }
  }
  return null;
}

// ── Config file existence scan ───────────────────────────────────────

const CONFIG_FILES = [
  "metro.config.js",
  "metro.config.ts",
  "babel.config.js",
  "babel.config.cjs",
  ".babelrc",
  "tsconfig.json",
  "app.json",
  "app.config.js",
  "app.config.ts",
  "eas.json",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierrc.js",
  ".prettierrc.json",
  "prettier.config.js",
  "jest.config.js",
  "jest.config.ts",
  ".detoxrc.js",
  ".detoxrc.json",
  ".maestro/",
  ".vscode/launch.json",
  "Makefile",
];

async function detectConfigFiles(workspacePath: string): Promise<string[]> {
  const results = await Promise.allSettled(
    CONFIG_FILES.map(async (file) => {
      if (await exists(join(workspacePath, file))) return file;
      return null;
    })
  );
  return results
    .filter(
      (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && r.value !== null
    )
    .map((r) => r.value);
}

// ── Tool versions ────────────────────────────────────────────────────

const VERSION_COMMANDS: [string, string, string[]][] = [
  ["node", "node", ["--version"]],
  ["npm", "npm", ["--version"]],
  ["yarn", "yarn", ["--version"]],
  ["pnpm", "pnpm", ["--version"]],
  ["bun", "bun", ["--version"]],
  ["pod", "pod", ["--version"]],
  ["eas", "eas", ["--version"]],
  ["expo", "expo", ["--version"]],
];

async function detectToolVersions(cwd: string): Promise<Record<string, string | null>> {
  const results = await Promise.allSettled(
    VERSION_COMMANDS.map(async ([key, cmd, args]) => {
      const version = await runVersionCommand(cmd, args, cwd);
      return [key, version] as const;
    })
  );
  const versions: Record<string, string | null> = {};
  for (const r of results) {
    if (r.status === "fulfilled") {
      versions[r.value[0]] = r.value[1];
    }
  }
  return versions;
}

// ── .env files ───────────────────────────────────────────────────────

async function detectEnvFiles(workspacePath: string): Promise<EnvFileInfo[]> {
  const entries = await listDir(workspacePath);
  if (!entries) return [];
  const envFileNames = entries.filter((e) => e === ".env" || e.startsWith(".env."));
  const results = await Promise.all(
    envFileNames.map(async (name) => {
      const content = await readTextFile(join(workspacePath, name));
      return {
        name,
        keys: content ? extractEnvKeys(content) : [],
      };
    })
  );
  return results;
}

// ── Main reader ──────────────────────────────────────────────────────

export async function readWorkspaceSnapshot(workspacePath: string): Promise<WorkspaceSnapshot> {
  const [
    packageJson,
    appJson,
    easJson,
    tsconfig,
    metroConfigRaw,
    babelConfigRaw,
    hasIosDir,
    hasAndroidDir,
    lockfile,
    envFiles,
    toolVersions,
    scriptsDirEntries,
    huskyHooks,
    ciConfig,
    configFilesFound,
  ] = await Promise.all([
    readJsonFile(join(workspacePath, "package.json")),
    readJsonFile(join(workspacePath, "app.json")),
    readJsonFile(join(workspacePath, "eas.json")),
    readJsonFile(join(workspacePath, "tsconfig.json")),
    readTextFile(join(workspacePath, "metro.config.js")).then(
      (r) => r ?? readTextFile(join(workspacePath, "metro.config.ts"))
    ),
    readTextFile(join(workspacePath, "babel.config.js")).then(
      (r) => r ?? readTextFile(join(workspacePath, "babel.config.cjs"))
    ),
    isDirectory(join(workspacePath, "ios")),
    isDirectory(join(workspacePath, "android")),
    detectLockfile(workspacePath),
    detectEnvFiles(workspacePath),
    detectToolVersions(workspacePath),
    listDir(join(workspacePath, "scripts")),
    listDir(join(workspacePath, ".husky")),
    detectCiConfig(workspacePath),
    detectConfigFiles(workspacePath),
  ]);

  const iosDir = join(workspacePath, "ios");
  const androidDir = join(workspacePath, "android");
  const [iosWorkspace, iosHasPodfile, makefileText, lintStagedConfig, androidHasGradle] =
    await Promise.all([
      hasIosDir ? findIosWorkspace(iosDir) : Promise.resolve(null),
      exists(join(workspacePath, "ios", "Podfile")),
      readTextFile(join(workspacePath, "Makefile")),
      detectLintStagedConfig(workspacePath, packageJson),
      hasAndroidDir ? exists(join(androidDir, "gradlew")) : Promise.resolve(false),
    ]);

  const metroPort = metroConfigRaw ? extractMetroPort(metroConfigRaw) : null;

  const makefileTargets = makefileText ? extractMakefileTargets(makefileText) : null;

  return {
    workspace_path: workspacePath,
    package_json: packageJson,
    metro_config_raw: metroConfigRaw,
    app_json: appJson,
    eas_json: easJson,
    tsconfig,
    babel_config_raw: babelConfigRaw,
    metro_port: metroPort,
    has_ios_dir: hasIosDir,
    has_android_dir: hasAndroidDir,
    ios_workspace: iosWorkspace,
    ios_has_podfile: iosHasPodfile,
    android_has_gradle: androidHasGradle,
    lockfile,
    env_files: envFiles,
    tool_versions: toolVersions,
    scripts_dir_entries: scriptsDirEntries,
    husky_hooks: huskyHooks,
    ci_config: ciConfig,
    makefile_targets: makefileTargets,
    lint_staged_config: lintStagedConfig,
    config_files_found: configFilesFound,
  };
}
