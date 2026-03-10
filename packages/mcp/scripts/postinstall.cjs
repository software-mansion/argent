#!/usr/bin/env node
// @ts-check
"use strict";

// Runs automatically after `npm install argent`.
// Writes MCP server config for Claude Code and Cursor, copies skill files.
// Set ARGENT_SKIP_POSTINSTALL=1 to opt out entirely.

if (process.env.ARGENT_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

const fs = require("fs");
const path = require("path");
const os = require("os");

// npm sets this to the directory that ran `npm install`
const projectRoot = process.env.npm_config_local_prefix;
if (!projectRoot) {
  // Global install or non-npm package manager — nothing to configure
  process.exit(0);
}

const distEntry = path.resolve(__dirname, "..", "dist", "index.js");
const skillsSrc = path.resolve(__dirname, "..", "skills");
const logFile = path.join(os.homedir(), ".argent", "mcp-calls.log");

const mcpEntry = {
  type: "stdio",
  command: "node",
  args: [distEntry],
  env: {
    RADON_MCP_LOG: logFile,
  },
};

/** @param {string} filePath */
function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

/** @param {string} filePath @param {any} data */
function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

/** @param {string} configPath @param {string} serverKey */
function registerMcpServer(configPath, serverKey) {
  const config = readJson(configPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers[serverKey] = mcpEntry;
  writeJson(configPath, config);
}

/** @param {string} settingsPath @param {string} rule */
function addPermission(settingsPath, rule) {
  const config = readJson(settingsPath);
  if (!config.permissions) config.permissions = {};
  if (!config.permissions.allow) config.permissions.allow = [];
  if (!config.permissions.allow.includes(rule)) {
    config.permissions.allow.push(rule);
    writeJson(settingsPath, config);
  }
}

/** @param {string} srcDir @param {string} destDir */
function copySkills(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.cpSync(srcDir, destDir, { recursive: true });
}

const results = [];

// Claude Code — .claude/mcp.json
try {
  registerMcpServer(path.join(projectRoot, ".claude", "mcp.json"), "argent");
  results.push("✓ Registered MCP server in .claude/mcp.json");
} catch (err) {
  results.push(`⚠ Could not write .claude/mcp.json: ${err}`);
}

// Cursor — .cursor/mcp.json
try {
  registerMcpServer(path.join(projectRoot, ".cursor", "mcp.json"), "argent");
  results.push("✓ Registered MCP server in .cursor/mcp.json");
} catch (err) {
  results.push(`⚠ Could not write .cursor/mcp.json: ${err}`);
}

// Claude Code permissions — .claude/settings.json
try {
  addPermission(path.join(projectRoot, ".claude", "settings.json"), "mcp__argent");
  results.push("✓ Added mcp__argent permission to .claude/settings.json");
} catch (err) {
  results.push(`⚠ Could not update .claude/settings.json: ${err}`);
}

// Skills — .claude/skills/
try {
  copySkills(skillsSrc, path.join(projectRoot, ".claude", "skills"));
  results.push("✓ Installed skill files to .claude/skills/");
} catch (err) {
  results.push(`⚠ Could not install skill files: ${err}`);
}

console.log("\nargent postinstall:");
for (const line of results) {
  console.log(" ", line);
}
console.log();
