#!/usr/bin/env node
"use strict";

// Runs automatically after `npm install @swmansion/argent`.
// Set ARGENT_SKIP_POSTINSTALL=1 to suppress the init message (used by `argent update`).

const os = require("os");
const fs = require("fs");
const path = require("path");

// Kill the running tool-server so the freshly-installed binary takes effect on
// next use — but ONLY when the tracked server belongs to THIS package's bundle.
// A repo-local devDependency install of argent must not tear down a tool-server
// spawned by a *different* install (another project's local copy, or the global
// binary) that an unrelated editor session is actively using.
const stateFile = path.join(os.homedir(), ".argent", "tool-server.json");
const ownBundlePath = path.resolve(__dirname, "..", "dist", "tool-server.cjs");

function sameBundle(recorded) {
  if (!recorded) return false;
  if (path.resolve(recorded) === ownBundlePath) return true;
  // Tolerate symlinked install layouts (npm global prefix, pnpm store) where the
  // recorded path and our __dirname resolve to the same real file.
  try {
    return fs.realpathSync(recorded) === fs.realpathSync(ownBundlePath);
  } catch {
    return false;
  }
}

try {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (state && state.pid && sameBundle(state.bundlePath)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* process already gone — nothing to kill */
    }
    fs.unlinkSync(stateFile);
  }
} catch {
  /* no state file or unreadable — nothing to clean up */
}

if (process.env.ARGENT_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

console.log(`
@swmansion/argent installed.

To set up your workspace (MCP server, skills, rules), run:

  argent init
`);
