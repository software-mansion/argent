#!/usr/bin/env node
"use strict";

// Runs automatically after `npm install @swmansion/argent`.
// Set ARGENT_SKIP_POSTINSTALL=1 to suppress the init message (used by `argent update`).

const os = require("os");
const fs = require("fs");
const path = require("path");

// Always kill any running tool-server so the new binary takes effect on next use.
const stateFile = path.join(os.homedir(), ".argent", "tool-server.json");
try {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (state && state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* process already gone — nothing to kill */
    }
  }
  fs.unlinkSync(stateFile);
} catch {
  /* no state file or unreadable — nothing to clean up */
}

// node-pty (optional dep, used by `argent lens`'s agent PTY proxy) ships its
// macOS prebuilt `spawn-helper` WITHOUT the executable bit, so the very first
// pty.spawn() fails with "posix_spawnp failed". Restore +x on every prebuild's
// helper. Best-effort and macOS-only: skip silently when node-pty isn't
// installed (the lens command then falls back to a new terminal window).
if (process.platform === "darwin") {
  try {
    const ptyDir = path.dirname(require.resolve("node-pty/package.json"));
    const prebuilds = path.join(ptyDir, "prebuilds");
    for (const entry of fs.readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, entry, "spawn-helper");
      try {
        fs.chmodSync(helper, 0o755);
      } catch {
        /* no helper for this arch — ignore */
      }
    }
  } catch {
    /* node-pty not installed or layout changed — lens falls back gracefully */
  }
}

if (process.env.ARGENT_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

console.log(`
@swmansion/argent installed.

To set up your workspace (MCP server, skills, rules), run:

  argent init
`);
