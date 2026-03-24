#!/usr/bin/env node
/**
 * Install argent in a target project or globally.
 *
 * Usage:
 *   node scripts/setup-project.cjs <project-path>    # local project install
 *   node scripts/setup-project.cjs --global           # global install
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { killArgentProcesses } = require(path.join(__dirname, "..", "packages", "mcp", "scripts", "kill-argent.cjs"));

const args = process.argv.slice(2);
const isGlobal = args.includes("--global");
const projectPath = args.find((a) => !a.startsWith("--"));

if (!isGlobal && !projectPath) {
  console.error("Usage:");
  console.error(
    "  node scripts/setup-project.cjs <project-path>    Local project install"
  );
  console.error(
    "  node scripts/setup-project.cjs --global           Global install"
  );
  process.exit(1);
}

const root = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Build & pack
// ---------------------------------------------------------------------------
console.log("Building and packing argent...");
execSync("npm run build -w @argent/registry", { cwd: root, stdio: "inherit" });
execSync("npm run pack:mcp", { cwd: root, stdio: "inherit" });

const mcpPkg = JSON.parse(
  fs.readFileSync(
    path.join(root, "packages", "mcp", "package.json"),
    "utf8"
  )
);
const tarball = path.join(root, `argent-${mcpPkg.version}.tgz`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function registerMcp(configPath, mcpEntry) {
  const config = readJson(configPath);
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.argent = mcpEntry;
  writeJson(configPath, config);
}

function grantPermission(settingsPath) {
  const settings = readJson(settingsPath);
  settings.permissions = settings.permissions || {};
  settings.permissions.allow = settings.permissions.allow || [];
  if (!settings.permissions.allow.includes("mcp__argent")) {
    settings.permissions.allow.push("mcp__argent");
  }
  writeJson(settingsPath, settings);
}

// ---------------------------------------------------------------------------
// Global install
// ---------------------------------------------------------------------------
if (isGlobal) {
  console.log("\nInstalling argent globally...");

  // Kill processes from the current global install and any repo dev build
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  killArgentProcesses([
    path.join(globalRoot, "argent", "dist"),
    path.join(root, "packages", "mcp", "dist"),
  ]);

  execSync(`npm install -g "${tarball}"`, { stdio: "inherit" });
  const globalEntry = path.join(globalRoot, "argent", "dist", "index.js");
  const logFile = path.join(os.homedir(), ".argent", "mcp-calls.log");
  const mcpEntry = {
    type: "stdio",
    command: "node",
    args: [globalEntry],
    env: { RADON_MCP_LOG: logFile },
  };

  registerMcp(path.join(os.homedir(), ".claude.json"), mcpEntry);
  grantPermission(path.join(os.homedir(), ".claude", "settings.json"));

  console.log("\n✓ Installed argent globally");
  console.log(`  MCP entry: node ${globalEntry}`);
  console.log("  Configured in ~/.claude.json and ~/.claude/settings.json");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Local project install
// ---------------------------------------------------------------------------
const projectRoot = path.resolve(projectPath);

if (!fs.existsSync(projectRoot)) {
  console.error(`Error: ${projectRoot} does not exist.`);
  process.exit(1);
}

// Kill processes from the existing local install and any repo dev build
killArgentProcesses([
  path.join(projectRoot, "node_modules", "argent", "dist"),
  path.join(root, "packages", "mcp", "dist"),
]);

console.log(`\nInstalling argent in ${projectRoot}...`);
execSync(`npm install --force "${tarball}"`, {
  cwd: projectRoot,
  stdio: "inherit",
});

const argentDist = path.join(
  projectRoot,
  "node_modules",
  "argent",
  "dist",
  "index.js"
);
const logFile = path.join(os.homedir(), ".argent", "mcp-calls.log");
const mcpEntry = {
  type: "stdio",
  command: "node",
  args: [argentDist],
  env: { RADON_MCP_LOG: logFile },
};

// Skills
const skillsSrc = path.join(root, "packages", "skills", "skills");
const skillsDest = path.join(projectRoot, ".claude", "skills");
if (fs.existsSync(skillsSrc)) {
  fs.mkdirSync(skillsDest, { recursive: true });
  fs.cpSync(skillsSrc, skillsDest, { recursive: true });
}

// Rules
const rulesSrc = path.join(root, "packages", "skills", "rules");
const rulesDest = path.join(projectRoot, ".claude", "rules");
if (fs.existsSync(rulesSrc)) {
  fs.mkdirSync(rulesDest, { recursive: true });
  fs.cpSync(rulesSrc, rulesDest, { recursive: true });
}

// MCP configs (merge — preserves other servers and .cursor/rules, etc.)
registerMcp(path.join(projectRoot, ".claude", "mcp.json"), mcpEntry);
registerMcp(path.join(projectRoot, ".cursor", "mcp.json"), mcpEntry);

// Claude permissions
grantPermission(path.join(projectRoot, ".claude", "settings.json"));

console.log("\n✓ Argent installed and configured");
console.log("  .claude/mcp.json       MCP server registered");
console.log("  .cursor/mcp.json       MCP server registered");
console.log("  .claude/settings.json  Permissions granted");
console.log("  .claude/skills/        Skills copied");
