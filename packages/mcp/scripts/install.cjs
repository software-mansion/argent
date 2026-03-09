#!/usr/bin/env node
// @ts-check
"use strict";

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

const logFile = path.join(os.homedir(), ".radon-lite", "mcp-calls.log");

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
  const rule = "mcp__radon-lite";
  if (!config.permissions.allow.includes(rule)) {
    config.permissions.allow.push(rule);
    writeJson(configPath, config);
    console.log("✓ Granted permissions for all radon-lite MCP tools");
  } else {
    console.log("  (permissions already granted)");
  }
}

if (userScope) {
  const userConfigPath = path.join(os.homedir(), ".claude.json");
  const config = readJson(userConfigPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers["radon-lite"] = entry;
  writeJson(userConfigPath, config);
  console.log("✓ Installed radon-lite MCP server (user scope)");
  if (allowPermissions) {
    const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
    addPermissions(userSettingsPath);
  }
} else {
  const projectConfigPath = path.resolve(__dirname, "../../../.claude/mcp.json");
  const config = readJson(projectConfigPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers["radon-lite"] = entry;
  writeJson(projectConfigPath, config);
  console.log("✓ Installed radon-lite MCP server (project scope)");
  if (allowPermissions) {
    const settingsPath = path.resolve(__dirname, "../../../.claude/settings.json");
    addPermissions(settingsPath);
  }
}
