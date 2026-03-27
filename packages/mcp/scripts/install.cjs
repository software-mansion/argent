#!/usr/bin/env node
// @ts-check
"use strict";

// DEPRECATED: This script is kept for backwards compatibility.
// Use `argent init` instead (after installing the package globally).
console.warn(
  "\x1b[33m[DEPRECATED]\x1b[0m scripts/install.cjs is deprecated. Use `argent init` instead."
);

const fs = require("fs");
const path = require("path");
const os = require("os");

const userScope = process.argv.includes("--user");
const allowPermissions = process.argv.includes("--allow");

const distEntry = path.resolve(__dirname, "../dist/index.js");

if (!fs.existsSync(distEntry)) {
  console.error(`Error: ${distEntry} not found. Run "npm run build" first.`);
  process.exit(1);
}

const logFile = path.join(os.homedir(), ".argent", "mcp-calls.log");

const entry = {
  type: "stdio",
  command: "node",
  args: [distEntry],
  env: {
    RADON_MCP_LOG: logFile,
  },
};

/** @param {string} configPath */
function readJson(configPath) {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    console.error(`Error: Could not parse ${configPath}`);
    process.exit(1);
  }
}

/** @param {string} configPath @param {any} config */
function writeJson(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** @param {string} configPath */
function addPermissions(configPath) {
  const config = readJson(configPath);
  if (!config.permissions) config.permissions = {};
  if (!config.permissions.allow) config.permissions.allow = [];
  const rule = "mcp__argent";
  if (!config.permissions.allow.includes(rule)) {
    config.permissions.allow.push(rule);
    writeJson(configPath, config);
    console.log("✓ Granted permissions for all argent MCP tools");
  } else {
    console.log("  (permissions already granted)");
  }
}

if (userScope) {
  const userConfigPath = path.join(os.homedir(), ".claude.json");
  const config = readJson(userConfigPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers["argent"] = entry;
  writeJson(userConfigPath, config);
  console.log("✓ Installed argent MCP server (user scope)");
  if (allowPermissions) {
    const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
    addPermissions(userSettingsPath);
  }
} else {
  const projectRoot = process.env.npm_config_local_prefix ?? process.cwd();

  // Claude Code
  const claudeConfigPath = path.join(projectRoot, ".claude", "mcp.json");
  const claudeConfig = readJson(claudeConfigPath);
  if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};
  claudeConfig.mcpServers["argent"] = entry;
  writeJson(claudeConfigPath, claudeConfig);
  console.log("✓ Installed argent MCP server in .claude/mcp.json");

  // Cursor
  const cursorConfigPath = path.join(projectRoot, ".cursor", "mcp.json");
  const cursorConfig = readJson(cursorConfigPath);
  if (!cursorConfig.mcpServers) cursorConfig.mcpServers = {};
  cursorConfig.mcpServers["argent"] = entry;
  writeJson(cursorConfigPath, cursorConfig);
  console.log("✓ Installed argent MCP server in .cursor/mcp.json");

  if (allowPermissions) {
    const settingsPath = path.join(projectRoot, ".claude", "settings.json");
    addPermissions(settingsPath);
  }
}
