#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Downloads signed native binaries (iOS dylibs + ax-service) from
 * `argent-private-releases`. Cross-platform replacement for the bash version
 * so this can run during a Windows packaging pipeline (the binaries are
 * macOS-only but the download itself is platform-neutral).
 *
 * Usage: node scripts/download-native-binaries.cjs [release-tag]
 *   release-tag  Optional GitHub release tag. Defaults to `argent-main`.
 *
 * Requires: `gh` CLI on PATH.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "software-mansion-labs/argent-private-releases";
const TAG = process.argv[2] ?? "argent-main";
const DYLIBS_DIR = path.resolve(__dirname, "..", "packages/native-devtools-ios/dylibs");
const BIN_DIR = path.resolve(__dirname, "..", "packages/native-devtools-ios/bin");

const DYLIBS = [
  "libNativeDevtoolsIos.dylib",
  "libKeyboardPatch.dylib",
  "libArgentInjectionBootstrap.dylib",
];

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.error) throw new Error(`Failed to run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function tryRun(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: "ignore", ...opts });
}

function ensureGh() {
  const which = process.platform === "win32" ? "where" : "which";
  if (spawnSync(which, ["gh"], { stdio: "ignore" }).status !== 0) {
    throw new Error("`gh` CLI not found on PATH. Install it (https://cli.github.com/) and retry.");
  }
}

function ensureReleaseExists() {
  const result = spawnSync("gh", ["release", "view", TAG, "--repo", REPO], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(
      `Release '${TAG}' not found in ${REPO}. Build and publish the native binaries for this version first, then retry.`
    );
  }
}

function main() {
  ensureGh();
  ensureReleaseExists();

  fs.mkdirSync(DYLIBS_DIR, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });

  console.log(`Downloading native binaries from ${REPO} (tag: ${TAG})`);

  for (const dylib of DYLIBS) {
    console.log(`  ${dylib}`);
    run("gh", [
      "release",
      "download",
      TAG,
      "--repo",
      REPO,
      "--pattern",
      dylib,
      "--dir",
      DYLIBS_DIR,
      "--clobber",
    ]);
  }

  console.log("  ax-service");
  run("gh", [
    "release",
    "download",
    TAG,
    "--repo",
    REPO,
    "--pattern",
    "ax-service",
    "--dir",
    BIN_DIR,
    "--clobber",
  ]);

  // chmod is a no-op on Windows; the dylibs/ax-service are macOS-only.
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(BIN_DIR, "ax-service"), 0o755);
  }

  // Best-effort signature verification on macOS only — codesign isn't
  // available elsewhere and the binaries are macOS-signed only.
  if (process.platform === "darwin") {
    for (const dylib of DYLIBS) {
      tryRun("codesign", ["-dvv", path.join(DYLIBS_DIR, dylib)]);
    }
    tryRun("codesign", ["-dvv", path.join(BIN_DIR, "ax-service")]);
  }

  console.log(
    `Downloaded native binaries to ${path.relative(process.cwd(), DYLIBS_DIR)}/ and ${path.relative(process.cwd(), BIN_DIR)}/`
  );
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
