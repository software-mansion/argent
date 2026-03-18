#!/usr/bin/env node
/**
 * Copies skills/ → .claude/skills/ and agents/ → .claude/agents/ in the nearest git root.
 * Run: node packages/skills/scripts/install.js
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, "..", "skills");
const agentsDir = join(__dirname, "..", "agents");

function gitRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

const root = gitRoot();

const skillsTarget = join(root, ".claude", "skills");
mkdirSync(skillsTarget, { recursive: true });
cpSync(skillsDir, skillsTarget, { recursive: true });
console.log(`Installed skills to ${skillsTarget}`);

if (existsSync(agentsDir)) {
  const agentsTarget = join(root, ".claude", "agents");
  mkdirSync(agentsTarget, { recursive: true });
  cpSync(agentsDir, agentsTarget, { recursive: true });
  console.log(`Installed agents to ${agentsTarget}`);
}
