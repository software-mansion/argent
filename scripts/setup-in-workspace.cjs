#!/usr/bin/env node
/**
 * Development script to setup argent in a workspace.
 * Build argent, then run `npx <tarball> init -y` in a target repository.
 *
 * Usage:
 *   node scripts/setup-project.cjs <project-path>
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const projectPath = process.argv[2];

if (!projectPath) {
  console.error("Usage: node scripts/setup-project.cjs <project-path>");
  process.exit(1);
}

const projectRoot = path.resolve(projectPath);

if (!fs.existsSync(projectRoot)) {
  console.error(`Error: ${projectRoot} does not exist.`);
  process.exit(1);
}

const root = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Build & pack
// ---------------------------------------------------------------------------
console.log("Building and packing argent...");
execSync("npm run pack:mcp", { cwd: root, stdio: "inherit" });

const mcpPkg = JSON.parse(
  fs.readFileSync(
    path.join(root, "packages", "mcp", "package.json"),
    "utf8"
  )
);
const tarball = path.join(root, `software-mansion-argent-${mcpPkg.version}.tgz`);

// ---------------------------------------------------------------------------
// Uninstall existing argent, then init from tarball
// ---------------------------------------------------------------------------
console.log(`\nUninstalling existing argent...`);
try {
  execSync("npm uninstall @software-mansion/argent", {
    cwd: projectRoot,
    stdio: "inherit",
  });
} catch {
  // Not installed locally — that's fine
}
try {
  execSync("npm uninstall -g @software-mansion/argent", { stdio: "inherit" });
} catch {
  // Not installed globally — that's fine
}

console.log(`\nInstalling argent globally from tarball...`);
execSync(`npm install -g "${tarball}"`, { stdio: "inherit" });

console.log(`\nRunning argent init...`);
execSync(`argent init`, {
  cwd: projectRoot,
  stdio: "inherit",
});

console.log("\n✓ Argent installed via init in", projectRoot);
