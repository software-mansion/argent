#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Downloads the simulator-server binaries for every supported platform from
 * the public `simulator-server-releases` repo. Replaces the previous bash
 * version so the pipeline runs on Windows, Linux, and macOS without invoking
 * `bash` directly.
 *
 * Usage: node scripts/download-simulator-server.cjs [release-tag]
 *   release-tag  Optional GitHub release tag. Defaults to `radon-main`.
 *
 * Requires: `gh` CLI on PATH. The repo is public, so no auth is needed.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "software-mansion-labs/simulator-server-releases";
const TAG = process.argv[2] ?? "radon-main";
const DEST_DIR = path.resolve(__dirname, "..", "packages/native-devtools-ios/bin");

// Platform → list of upstream asset names that should be downloaded into bin/.
// Each entry's `to` is the on-disk filename the runtime resolver expects.
//   - macOS uses the argent-customized build (`-argent-` suffix), required
//     for iOS simulator features that depend on Argent's protocol additions.
//   - Windows targets Android only, so the vanilla upstream build is enough.
//   - Linux is built but unused at the moment; included so the same package
//     can grow Linux support later without re-touching the download pipeline.
const ASSETS = [
  { from: "simulator-server-argent-macos", to: "simulator-server" },
  { from: "simulator-server-windows.exe", to: "simulator-server.exe" },
  { from: "simulator-server-linux", to: "simulator-server-linux" },
];

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.error) {
    throw new Error(`Failed to run ${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function ensureGh() {
  const which = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(which, ["gh"], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(
      "`gh` CLI not found on PATH. Install GitHub CLI (https://cli.github.com/) and retry."
    );
  }
}

function main() {
  ensureGh();
  fs.mkdirSync(DEST_DIR, { recursive: true });

  console.log(`Downloading simulator-server assets from ${REPO} (tag: ${TAG}) → ${DEST_DIR}`);

  for (const { from, to } of ASSETS) {
    console.log(`  ${from} → ${to}`);
    run("gh", [
      "release",
      "download",
      TAG,
      "--repo",
      REPO,
      "--pattern",
      from,
      "--dir",
      DEST_DIR,
      "--clobber",
    ]);

    const downloaded = path.join(DEST_DIR, from);
    const final = path.join(DEST_DIR, to);
    if (downloaded !== final) {
      fs.renameSync(downloaded, final);
    }
    // chmod is a no-op on Windows but matters on POSIX so the binary can be
    // exec'd directly. fs.chmodSync silently ignores the call on Windows.
    if (process.platform !== "win32") {
      fs.chmodSync(final, 0o755);
    }
  }

  console.log("Done.");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
