#!/usr/bin/env node
// @ts-check
"use strict";

// DEPRECATED: This script is kept for backwards compatibility.
// Use `argent uninstall` instead (after installing the package globally).
console.warn(
  "\x1b[33m[DEPRECATED]\x1b[0m scripts/uninstall.cjs is deprecated. Use `argent uninstall` instead."
);

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { killArgentProcesses } = require("./kill-argent.cjs");

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
  const idx = allow.indexOf("mcp__argent");
  if (idx === -1) return;
  allow.splice(idx, 1);
  if (allow.length === 0) delete config.permissions.allow;
  if (Object.keys(config.permissions).length === 0) delete config.permissions;
  writeJson(configPath, config);
  console.log("✓ Removed permissions for argent MCP tools");
}

if (userScope) {
  // Kill processes running from the global argent install
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    killArgentProcesses(path.join(globalRoot, "argent", "dist"));
  } catch {
    // npm root -g may fail in some environments — skip silently
  }

  const userConfigPath = path.join(os.homedir(), ".claude.json");
  if (!fs.existsSync(userConfigPath)) {
    console.log("(not found, nothing to do)");
    process.exit(0);
  }
  const config = readJson(userConfigPath);
  if (!config.mcpServers || !config.mcpServers["argent"]) {
    console.log("(not found, nothing to do)");
    process.exit(0);
  }
  delete config.mcpServers["argent"];
  writeJson(userConfigPath, config);
  console.log("✓ Uninstalled argent MCP server");
  if (allowPermissions) {
    const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
    removePermissions(userSettingsPath);
  }
} else {
  const projectRoot = process.env.npm_config_local_prefix ?? process.cwd();

  // Kill processes running from this project's argent installation
  killArgentProcesses(path.join(projectRoot, "node_modules", "argent", "dist"));

  // Claude Code
  const claudeConfigPath = path.join(projectRoot, ".claude", "mcp.json");
  if (fs.existsSync(claudeConfigPath)) {
    const config = readJson(claudeConfigPath);
    if (config.mcpServers?.["argent"]) {
      delete config.mcpServers["argent"];
      writeJson(claudeConfigPath, config);
      console.log("✓ Uninstalled argent MCP server from .claude/mcp.json");
    } else {
      console.log("  (.claude/mcp.json — not found, nothing to do)");
    }
  }

  // Cursor
  const cursorConfigPath = path.join(projectRoot, ".cursor", "mcp.json");
  if (fs.existsSync(cursorConfigPath)) {
    const config = readJson(cursorConfigPath);
    if (config.mcpServers?.["argent"]) {
      delete config.mcpServers["argent"];
      writeJson(cursorConfigPath, config);
      console.log("✓ Uninstalled argent MCP server from .cursor/mcp.json");
    } else {
      console.log("  (.cursor/mcp.json — not found, nothing to do)");
    }
  }

  if (allowPermissions) {
    const settingsPath = path.join(projectRoot, ".claude", "settings.json");
    removePermissions(settingsPath);
  }
}
