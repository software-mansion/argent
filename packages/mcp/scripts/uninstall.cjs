#!/usr/bin/env node
// @ts-check
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const userScope = process.argv.includes("--user");
const allowPermissions = process.argv.includes("--allow");

/** @param {string} configPath */
function readJson(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    console.error(`Error: Could not parse ${configPath}`);
    process.exit(1);
  }
}

/** @param {string} configPath @param {any} config */
function writeJson(configPath, config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** @param {string} configPath */
function removePermissions(configPath) {
  if (!fs.existsSync(configPath)) return;
  const config = readJson(configPath);
  const allow = config?.permissions?.allow;
  if (!Array.isArray(allow)) return;
  const idx = allow.indexOf("mcp__radon-lite");
  if (idx === -1) return;
  allow.splice(idx, 1);
  if (allow.length === 0) delete config.permissions.allow;
  if (Object.keys(config.permissions).length === 0) delete config.permissions;
  writeJson(configPath, config);
  console.log("✓ Removed permissions for radon-lite MCP tools");
}

if (userScope) {
  const userConfigPath = path.join(os.homedir(), ".claude.json");
  if (!fs.existsSync(userConfigPath)) {
    console.log("(not found, nothing to do)");
    process.exit(0);
  }
  const config = readJson(userConfigPath);
  if (!config.mcpServers || !config.mcpServers["radon-lite"]) {
    console.log("(not found, nothing to do)");
    process.exit(0);
  }
  delete config.mcpServers["radon-lite"];
  writeJson(userConfigPath, config);
  console.log("✓ Uninstalled radon-lite MCP server");
  if (allowPermissions) {
    const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
    removePermissions(userSettingsPath);
  }
} else {
  const projectConfigPath = path.resolve(__dirname, "../../../.claude/mcp.json");
  if (!fs.existsSync(projectConfigPath)) {
    console.log("(not found, nothing to do)");
    process.exit(0);
  }
  const config = readJson(projectConfigPath);
  if (!config.mcpServers || !config.mcpServers["radon-lite"]) {
    console.log("(not found, nothing to do)");
    process.exit(0);
  }
  delete config.mcpServers["radon-lite"];
  writeJson(projectConfigPath, config);
  console.log("✓ Uninstalled radon-lite MCP server");
  if (allowPermissions) {
    const settingsPath = path.resolve(__dirname, "../../../.claude/settings.json");
    removePermissions(settingsPath);
  }
}
