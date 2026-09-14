#!/usr/bin/env node
// @ts-check
"use strict";

// Pins the argent-private-releases tag the native binaries and the
// trace-processor bundle are downloaded from (default: argent-main):
//
//   npm run pack:mcp -- argent-v0.7.1
//
// simulator-server is a separate release stream with its own default, so it
// never takes the tag.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const WORKSPACE_ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error(`Unexpected extra arguments: ${args.slice(1).join(" ")}`);
  console.error("Usage: npm run pack:mcp -- [argent-release-tag]");
  process.exit(1);
}
const tag = args[0];

/** @param {string} cmd @param {string[]} cmdArgs */
function run(cmd, cmdArgs) {
  const display = [cmd, ...cmdArgs].join(" ");
  console.log(`\n› ${display}`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: WORKSPACE_ROOT,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`\nCommand failed (${result.status}): ${display}`);
    process.exit(result.status ?? 1);
  }
}

run("bash", ["scripts/download-simulator-server.sh"]);
run("bash", ["scripts/download-native-binaries.sh", ...(tag ? [tag] : [])]);
run("bash", ["scripts/download-trace-processor.sh", ...(tag ? [tag] : [])]);
run("npm", ["run", "build"]);
run("npm", ["run", "build", "-w", "@swmansion/argent"]);
run("npm", ["pack", "-w", "@swmansion/argent", "--pack-destination", "."]);
