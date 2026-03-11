#!/usr/bin/env node
/**
 * Dev-in-project: build, pack, open project window, install argent, sync .claude/.cursor from repo.
 * Used by the "Dev in project (open window, install, debug)" launch config.
 * Usage: node scripts/setup-dev-in-project.cjs <project-path>
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const projectPath = process.argv[2];
if (!projectPath) {
  console.error("Usage: node scripts/setup-dev-in-project.cjs <project-path>");
  process.exit(1);
}

const root = path.resolve(__dirname, "..");
const projectRoot = path.resolve(projectPath);

// 1. Build and pack
console.log("Building registry and packing MCP...");
execSync("npm run build -w @argent/registry", { cwd: root, stdio: "inherit" });
execSync("npm run pack:mcp", { cwd: root, stdio: "inherit" });

// 2. Open project in new window
console.log("Opening project in new VS Code window...");
execSync(`code "${projectRoot}"`, { cwd: root, stdio: "inherit" });

// 3. Install argent in project
console.log("Installing argent in project...");
const mcpPkg = JSON.parse(fs.readFileSync(path.join(root, "packages", "mcp", "package.json"), "utf8"));
execSync(`npm install --force "${path.join(root, `argent-${mcpPkg.version}.tgz`)}"`, { cwd: projectRoot, stdio: "inherit" });

// 4. Sync .claude and .cursor from repo (remove old, copy skills + write MCP config)
const skillsSrc = path.join(root, "packages", "skills", "skills");
const argentDist = path.join(projectRoot, "node_modules", "argent", "dist", "index.js");
const mcpEntry = { type: "stdio", command: "node", args: [argentDist], env: { RADON_MCP_LOG: path.join(os.homedir(), ".argent", "mcp-calls.log") } };

for (const dir of [".claude", ".cursor"]) {
  const full = path.join(projectRoot, dir);
  if (fs.existsSync(full)) fs.rmSync(full, { recursive: true });
}
fs.mkdirSync(path.join(projectRoot, ".claude", "skills"), { recursive: true });
if (fs.existsSync(skillsSrc)) fs.cpSync(skillsSrc, path.join(projectRoot, ".claude", "skills"), { recursive: true });

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}
writeJson(path.join(projectRoot, ".claude", "mcp.json"), { mcpServers: { argent: mcpEntry } });
writeJson(path.join(projectRoot, ".cursor", "mcp.json"), { mcpServers: { argent: mcpEntry } });
const settingsPath = path.join(projectRoot, ".claude", "settings.json");
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
settings.permissions = settings.permissions || {};
settings.permissions.allow = settings.permissions.allow || [];
if (!settings.permissions.allow.includes("mcp__argent")) settings.permissions.allow.push("mcp__argent");
writeJson(settingsPath, settings);

console.log("Synced .claude and .cursor from repo. Tools Server will start in this window with debugger attached.");
