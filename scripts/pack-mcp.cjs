#!/usr/bin/env node
// @ts-check
"use strict";

// Wraps the @swmansion/argent pack pipeline so callers can pin which
// argent-private-releases tag the native binaries come from:
//
//   npm run pack:mcp                          # default: argent-main
//   npm run pack:mcp -- argent-v0.7.1         # specific release tag
//   npm run pack:mcp -- argent-my-branch      # tag produced by triggering
//                                             # build-native-binaries.yml on a
//                                             # branch
//
// Only `download-native-binaries.sh` takes the tag; simulator-server lives in
// a separate release stream with its own default and is left untouched.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const WORKSPACE_ROOT = path.resolve(__dirname, "..");

// First positional after `--` becomes the tag. Anything else is rejected so
// typos like `npm run pack:mcp -- --tag=foo` don't silently get ignored.
const args = process.argv.slice(2);
if (args.length > 1) {
  console.error(`Unexpected extra arguments: ${args.slice(1).join(" ")}`);
  console.error("Usage: npm run pack:mcp -- [argent-release-tag]");
  process.exit(1);
}
const tag = args[0];

// The Android trace-processor engine ships as three third-party WASM artifacts
// (trace_processor.wasm + emscripten glue + the EngineBase decoder) plus the
// Perfetto LICENSE. They are NOT committed to the repo; download-trace-processor.sh
// fetches and sha256-verifies them from argent-private-releases at pack time
// (same tag as the native binaries) so they land in the published tarball under
// packages/native-devtools-android/assets/trace-processor/. download-native-binaries.sh
// still fetches the iOS binaries and the Android helper APK.

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
