#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Downloads the argent-stripped simulator-server binary from the public
 * `simulator-server-releases` repo. Replaces the previous bash script so
 * the pipeline runs on Windows, Linux, and macOS hosts without invoking
 * `bash` directly — but the *bundled* artifact remains macOS-only.
 *
 * IMPORTANT — Why we only download the macOS variant
 * --------------------------------------------------
 * Upstream `radon-main` ships:
 *   • simulator-server-argent-macos  — argent-stripped (no `stream_ready`)
 *   • simulator-server-macos          — vanilla
 *   • simulator-server-linux          — vanilla
 *   • simulator-server-windows.exe    — vanilla
 *
 * Only the `-argent-` variant has streaming endpoints removed. Shipping
 * the vanilla Windows / Linux binaries inside `@swmansion/argent` would
 * give non-mac users a streaming surface the macOS build deliberately
 * suppresses — feature-parity divergence and an IP/licensing concern.
 *
 * Until upstream publishes `simulator-server-argent-windows.exe` and
 * `simulator-server-argent-linux`, `@swmansion/argent` ships only the
 * macOS binary. The runtime resolver in `@argent/native-devtools-ios`
 * still has Windows / Linux branches so the pipeline is ready to flip
 * the moment the argent-stripped builds exist; today the resolver
 * throws "binary not found" on those platforms, which is the correct
 * fail-closed behavior.
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

// Each entry's `to` is the on-disk filename the runtime resolver expects.
// New platforms get added here only once the upstream publishes a
// `simulator-server-argent-<platform>` asset (i.e. with streaming
// stripped). Do not add the vanilla `simulator-server-windows.exe` /
// `simulator-server-linux` assets — see file header for the rationale.
const ASSETS = [{ from: "simulator-server-argent-macos", to: "simulator-server" }];

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

  console.log(
    `Downloading argent simulator-server assets from ${REPO} (tag: ${TAG}) → ${DEST_DIR}`
  );

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
