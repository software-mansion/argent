#!/usr/bin/env node
/**
 * Copies skills/ → .claude/skills/ in the nearest git root.
 * Run: node packages/skills/scripts/install.js
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, "..", "skills");

function gitRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

const targetDir = join(gitRoot(), ".claude", "skills");
mkdirSync(targetDir, { recursive: true });
cpSync(skillsDir, targetDir, { recursive: true });
console.log(`Installed skills to ${targetDir}`);
