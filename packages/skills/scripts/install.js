#!/usr/bin/env node
/** Copies skills/ and agents/ into .claude/ at the nearest git root (cwd if none). */
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyDir } from "@argent/installer";

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
if (copyDir(skillsDir, skillsTarget)) console.log(`Installed skills to ${skillsTarget}`);

const agentsTarget = join(root, ".claude", "agents");
if (copyDir(agentsDir, agentsTarget)) console.log(`Installed agents to ${agentsTarget}`);
