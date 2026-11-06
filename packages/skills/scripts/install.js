#!/usr/bin/env node
/** Copies skills/ and agents/ into .claude/ at the nearest git root (cwd if none). */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
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

// cpSync refuses a symlinked destination dir (ERR_FS_CP_DIR_TO_NON_DIR), so copy
// into the directory the link points at.
function copyInto(src, dest) {
  const target = existsSync(dest) ? realpathSync(dest) : dest;
  mkdirSync(target, { recursive: true });
  cpSync(src, target, { recursive: true });
}

const root = gitRoot();

const skillsTarget = join(root, ".claude", "skills");
copyInto(skillsDir, skillsTarget);
console.log(`Installed skills to ${skillsTarget}`);

if (existsSync(agentsDir)) {
  const agentsTarget = join(root, ".claude", "agents");
  copyInto(agentsDir, agentsTarget);
  console.log(`Installed agents to ${agentsTarget}`);
}
