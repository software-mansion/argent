#!/usr/bin/env node
/**
 * argent CLI — install, update, and remove argent in a workspace.
 *
 * Usage:
 *   npx argent install   Install and configure argent in the current project
 *   npx argent update    Check for updates, apply them, refresh workspace files
 *   npx argent remove    Remove argent from the current project
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Configurable constants ────────────────────────────────────────────────────
// Change PACKAGE_NAME if the npm package name changes, and NPM_REGISTRY if
// you need to point at a private registry or mirror.
const PACKAGE_NAME = "@software-mansion/argent";
const NPM_REGISTRY = "https://npm.pkg.github.com";
const MCP_SERVER_KEY = "argent";
const PERMISSION_RULE = "mcp__argent";
// ─────────────────────────────────────────────────────────────────────────────

const [, , command, ...rest] = process.argv;
const projectRoot = rest.find((a) => !a.startsWith("--")) ?? process.cwd();
const flags = new Set(rest.filter((a) => a.startsWith("--")));

// ── Utilities ─────────────────────────────────────────────────────────────────

function readJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function writeJson(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function registerMcpServer(
  configPath: string,
  mcpEntry: Record<string, unknown>,
) {
  const config = readJson(configPath);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers[MCP_SERVER_KEY] = mcpEntry;
  config.mcpServers = servers;
  writeJson(configPath, config);
}

function removeMcpServer(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  const config = readJson(configPath);
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers?.[MCP_SERVER_KEY]) return false;
  delete servers[MCP_SERVER_KEY];
  writeJson(configPath, config);
  return true;
}

function addPermission(settingsPath: string, rule: string) {
  const config = readJson(settingsPath);
  const permissions = (config.permissions ?? {}) as Record<string, unknown>;
  const allow = (permissions.allow ?? []) as string[];
  if (!allow.includes(rule)) {
    allow.push(rule);
    permissions.allow = allow;
    config.permissions = permissions;
    writeJson(settingsPath, config);
  }
}

function removePermission(settingsPath: string, rule: string) {
  if (!fs.existsSync(settingsPath)) return;
  const config = readJson(settingsPath);
  const allow = (config?.permissions as Record<string, unknown>)
    ?.allow as string[];
  if (!Array.isArray(allow)) return;
  const idx = allow.indexOf(rule);
  if (idx === -1) return;
  allow.splice(idx, 1);
  writeJson(settingsPath, config);
}

function copyDir(src: string, dest: string): boolean {
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

function getInstalledVersion(root: string): string | null {
  const pkgPath = path.join(
    root,
    "node_modules",
    ...PACKAGE_NAME.split("/"),
    "package.json",
  );
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function getLatestVersion(): string {
  const result = execSync(
    `npm view ${PACKAGE_NAME} version --registry ${NPM_REGISTRY}`,
    { encoding: "utf8" },
  );
  return result.trim();
}

/**
 * Write MCP config entries and copy skills/agents/rules from the installed
 * package into the workspace.  Returns a log of what happened.
 */
function configure(root: string): string[] {
  const pkgDir = path.join(root, "node_modules", ...PACKAGE_NAME.split("/"));
  const distEntry = path.join(pkgDir, "dist", "index.js");
  const logFile = path.join(os.homedir(), ".argent", "mcp-calls.log");

  const mcpEntry: Record<string, unknown> = {
    type: "stdio",
    command: "node",
    args: [distEntry],
    env: { ARGENT_MCP_LOG: logFile },
  };

  const results: string[] = [];

  const mcpTargets: [string, string][] = [
    [".claude/mcp.json", ".claude/mcp.json"],
    [".cursor/mcp.json", ".cursor/mcp.json"],
    [".mcp.json", ".mcp.json"],
  ];

  for (const [rel, label] of mcpTargets) {
    try {
      registerMcpServer(path.join(root, rel), mcpEntry);
      results.push(`  ✓ Registered MCP server in ${label}`);
    } catch (err) {
      results.push(`  ⚠ Could not write ${label}: ${err}`);
    }
  }

  try {
    addPermission(path.join(root, ".claude", "settings.json"), PERMISSION_RULE);
    results.push(`  ✓ Added ${PERMISSION_RULE} to .claude/settings.json`);
  } catch (err) {
    results.push(`  ⚠ Could not update .claude/settings.json: ${err}`);
  }

  const fileSets: [string, string, string][] = [
    [path.join(pkgDir, "skills"), path.join(root, ".claude", "skills"), ".claude/skills"],
    [path.join(pkgDir, "agents"), path.join(root, ".claude", "agents"), ".claude/agents"],
    [path.join(pkgDir, "rules"), path.join(root, ".claude", "rules"), ".claude/rules"],
    [path.join(pkgDir, "rules"), path.join(root, ".cursor", "rules"), ".cursor/rules"],
  ];

  for (const [src, dest, label] of fileSets) {
    try {
      if (copyDir(src, dest)) {
        results.push(`  ✓ Copied files to ${label}`);
      }
    } catch (err) {
      results.push(`  ⚠ Could not copy to ${label}: ${err}`);
    }
  }

  return results;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function install() {
  const existing = getInstalledVersion(projectRoot);
  if (existing) {
    console.log(
      `\nFound existing ${PACKAGE_NAME}@${existing} — reinstalling/updating...\n`,
    );
  } else {
    console.log(`\nInstalling ${PACKAGE_NAME}...\n`);
  }

  execSync(`npm install ${PACKAGE_NAME} --registry ${NPM_REGISTRY}`, {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, ARGENT_SKIP_POSTINSTALL: "1" },
  });

  console.log("\nConfiguring workspace...\n");
  const results = configure(projectRoot);
  for (const line of results) console.log(line);
  console.log(`\n✓ ${PACKAGE_NAME} installed and configured.\n`);
}

async function update() {
  const installed = getInstalledVersion(projectRoot);
  if (!installed) {
    console.error(
      `\n${PACKAGE_NAME} is not installed in this project. Run:\n\n  npx ${PACKAGE_NAME} install\n`,
    );
    process.exit(1);
  }

  console.log(`\nChecking for ${PACKAGE_NAME} updates...\n`);
  let latest: string;
  try {
    latest = getLatestVersion();
  } catch (err) {
    console.error(`  ⚠ Could not reach npm registry: ${err}`);
    process.exit(1);
  }

  console.log(`  Installed : v${installed}`);
  console.log(`  Latest    : v${latest}`);

  if (installed !== latest) {
    console.log(`\n  Updating to v${latest}...\n`);
    execSync(`npm install ${PACKAGE_NAME}@${latest} --registry ${NPM_REGISTRY}`, {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, ARGENT_SKIP_POSTINSTALL: "1" },
    });
  } else {
    console.log(`\n  Already on the latest version.`);
  }

  console.log("\nRefreshing workspace configuration...\n");
  const results = configure(projectRoot);
  for (const line of results) console.log(line);
  console.log(`\n✓ ${PACKAGE_NAME} is up to date.\n`);
}

async function remove() {
  const pruneFiles = flags.has("--prune");

  console.log(`\nRemoving ${PACKAGE_NAME} from workspace...\n`);
  const results: string[] = [];

  const mcpTargets: [string, string][] = [
    [".claude/mcp.json", ".claude/mcp.json"],
    [".cursor/mcp.json", ".cursor/mcp.json"],
    [".mcp.json", ".mcp.json"],
  ];

  for (const [rel, label] of mcpTargets) {
    try {
      const removed = removeMcpServer(path.join(projectRoot, rel));
      results.push(
        removed
          ? `  ✓ Removed MCP entry from ${label}`
          : `  — ${label}: entry not present`,
      );
    } catch (err) {
      results.push(`  ⚠ Could not update ${label}: ${err}`);
    }
  }

  try {
    removePermission(
      path.join(projectRoot, ".claude", "settings.json"),
      PERMISSION_RULE,
    );
    results.push(`  ✓ Removed ${PERMISSION_RULE} from .claude/settings.json`);
  } catch (err) {
    results.push(`  ⚠ Could not update .claude/settings.json: ${err}`);
  }

  if (pruneFiles) {
    const dirs: [string, string][] = [
      [path.join(projectRoot, ".claude", "skills"), ".claude/skills"],
      [path.join(projectRoot, ".claude", "agents"), ".claude/agents"],
      [path.join(projectRoot, ".claude", "rules"), ".claude/rules"],
      [path.join(projectRoot, ".cursor", "rules"), ".cursor/rules"],
    ];
    for (const [dir, label] of dirs) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true });
          results.push(`  ✓ Removed ${label}`);
        }
      } catch (err) {
        results.push(`  ⚠ Could not remove ${label}: ${err}`);
      }
    }
  } else {
    results.push(
      `  — Kept .claude/skills, .claude/agents, .claude/rules, .cursor/rules`,
    );
    results.push(`    (pass --prune to also remove these directories)`);
  }

  try {
    execSync(`npm uninstall ${PACKAGE_NAME} --registry ${NPM_REGISTRY}`, {
      cwd: projectRoot,
      stdio: "inherit",
    });
    results.push(`  ✓ Uninstalled ${PACKAGE_NAME} from node_modules`);
  } catch (err) {
    results.push(`  ⚠ Could not uninstall package: ${err}`);
  }

  for (const line of results) console.log(line);
  console.log(`\n✓ ${PACKAGE_NAME} removed.\n`);
}

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Usage: npx ${PACKAGE_NAME} <command> [path] [options]

Commands:
  install   Install and configure ${PACKAGE_NAME} in the current project
  update    Check for updates, apply them, and refresh workspace files
  remove    Remove ${PACKAGE_NAME} from the current project

Arguments:
  path      Target project directory (defaults to current working directory)

Options for remove:
  --prune   Also delete .claude/skills, .claude/agents, and rules directories
`);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, () => Promise<void>> = {
  install,
  update,
  remove,
};

if (!command || !(command in COMMANDS)) {
  printHelp();
  process.exit(command ? 1 : 0);
}

await COMMANDS[command]();
