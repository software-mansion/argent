#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Tiny dispatcher invoked by the npm-installed `argent-simulator-server`
 * shim. Picks the right native binary for the current platform and replaces
 * the current process with it (well, on Windows, spawns it and exits with
 * the same status — Windows has no execve).
 *
 * The actual binaries live alongside this wrapper inside `bin/`:
 *   - macOS:    simulator-server  (Mach-O universal)
 *   - Windows:  simulator-server.exe
 *   - Linux:    simulator-server-linux
 */

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const FILENAME =
  process.platform === "win32"
    ? "simulator-server.exe"
    : process.platform === "linux"
      ? "simulator-server-linux"
      : "simulator-server";

const binary = path.join(__dirname, FILENAME);

if (!fs.existsSync(binary)) {
  console.error(
    `argent-simulator-server: no binary for ${process.platform} at ${binary}.\n` +
      `This usually means the package was published without a binary for this platform.`
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`argent-simulator-server: failed to spawn binary: ${result.error.message}`);
  process.exit(1);
}
// `status` is null when the child was killed by a signal — exit non-zero
// instead of falsely reporting success. Windows can't forward arbitrary
// kill signals back to the parent's shell, so a concrete code is what
// callers (and the npm shim) actually inspect.
if (typeof result.status === "number") {
  process.exit(result.status);
}
process.exit(1);
