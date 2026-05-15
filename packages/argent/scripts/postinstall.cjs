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
    } catch {}
  }
  fs.unlinkSync(stateFile);
} catch {}

if (process.env.ARGENT_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

console.log(`
@swmansion/argent installed.

To set up your workspace (MCP server, skills, rules), run:

  argent init
`);
