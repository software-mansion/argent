#!/usr/bin/env node
/**
 * Dev-in-project: clean .claude/.cursor, install argent, open project in new VS Code window.
 * Used by the "Argent Agent Debug" launch config.
 * Usage: node scripts/setup-dev-in-project.cjs <project-path>
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const projectPath = process.argv[2];
if (!projectPath) {
  console.error(
    "Usage: node scripts/setup-dev-in-project.cjs <project-path>"
  );
  process.exit(1);
}

const projectRoot = path.resolve(projectPath);

// Clean slate for dev workflow (setup-project.cjs merges by default)
for (const dir of [".claude", ".cursor"]) {
  const full = path.join(projectRoot, dir);
  if (fs.existsSync(full)) fs.rmSync(full, { recursive: true });
}

// Delegate build + install + config to setup-project.cjs
execSync(
  `node "${path.join(__dirname, "setup-project.cjs")}" "${projectRoot}"`,
  { stdio: "inherit" }
);

// Open project in new VS Code window
console.log("Opening project in new VS Code window...");
execSync(`code "${projectRoot}"`, { stdio: "inherit" });

console.log(
  "Tools Server will start in this window with debugger attached."
);
