#!/usr/bin/env node
/** Copies skills/ and agents/ into .claude/ at the nearest git root (cwd if none). */
import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
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

// mkdirSync fails on a dangling link anywhere in the path, so create what each
// one ends at first.
function ensureDir(dir, hops = 0) {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat && existsSync(dir)) return;
  // Past the cap, let mkdirSync report the loop.
  if (hops >= 40) return void mkdirSync(dir, { recursive: true });
  if (stat?.isSymbolicLink()) {
    ensureDir(resolve(realpathSync(dirname(dir)), readlinkSync(dir)), hops + 1);
    return;
  }
  ensureDir(dirname(dir), hops);
  mkdirSync(dir);
}

// File by file rather than cpSync, which refuses or replaces a symlink inside the
// destination (a per-skill link from `npx skills add`, a linked SKILL.md) depending on
// the Node version. mkdirSync and copyFileSync write through one.
function copyInto(src, dest) {
  ensureDir(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyInto(from, to);
    else copyFileSync(from, to);
  }
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
