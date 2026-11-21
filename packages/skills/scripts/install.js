#!/usr/bin/env node
/** Copies skills/ into .claude/skills at the nearest git root (cwd if none). */
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

function gitRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// Makes `path` a dir or, for a file, the dir copyFileSync writes it into.
// mkdirSync fails on a dangling link anywhere in the path, so create what each
// one ends at first, but only when something is at that target's parent (a
// dangling link there is completed the same way): a mistyped
// `.claude/skills -> ../.agnets/skills` must fail, not build `.agnets/`.
function prepare(path, isFile = false, hops = 0, link) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && existsSync(path)) return;
  if (stat?.isSymbolicLink()) {
    // Past the cap, let mkdirSync report the loop.
    if (hops >= 40) return void mkdirSync(path, { recursive: true });
    prepare(resolve(realpathSync(dirname(path)), readlinkSync(path)), isFile, hops + 1, path);
    return;
  }
  const parent = dirname(path);
  if (link && !lstatSync(parent, { throwIfNoEntry: false })) {
    throw new Error(`${link} links to ${path}, but ${parent} does not exist`);
  }
  prepare(parent, false, hops);
  if (!isFile) mkdirSync(path);
}

// File by file rather than cpSync, which refuses or replaces a symlink inside the
// destination (a per-skill link from `npx skills add`, a linked SKILL.md) depending on
// the Node version. mkdirSync and copyFileSync write through one.
function copyInto(src, dest) {
  prepare(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyInto(from, to);
    } else {
      prepare(to, true);
      copyFileSync(from, to);
    }
  }
}

const skillsTarget = join(gitRoot(), ".claude", "skills");
try {
  copyInto(skillsDir, skillsTarget);
  console.log(`Installed skills to ${skillsTarget}`);
} catch (err) {
  console.error(`Could not install skills: ${err.message}`);
  process.exitCode = 1;
}
