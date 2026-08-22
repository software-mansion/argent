#!/usr/bin/env node
"use strict";

// Dispatcher published as the `argent-simulator-server` bin entry. npm's `bin`
// field resolves to a single file regardless of host platform, but the
// simulator-server binary is platform-specific, so pick it at invocation time
// and spawn it with the caller's args.

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// Mirrors hostPlatformKey() in @argent/native-devtools-ios; duplicated because
// this file ships verbatim as the npm `bin` entry and can't import. darwin ships
// a universal (lipo) binary, but Linux binaries are single-arch ELFs, so arm64
// Linux gets its own "linux-arm64" directory next to the x86_64 one ("linux").
const platformKey =
  process.platform === "linux" && process.arch === "arm64" ? "linux-arm64" : process.platform;

// Mirrors simulatorServerBinaryName() in @argent/native-devtools-ios; inlined
// because this file ships verbatim as the npm `bin` entry and can't import.
const binaryName = process.platform === "win32" ? "simulator-server.exe" : "simulator-server";

const binary = path.join(__dirname, platformKey, binaryName);
if (!fs.existsSync(binary)) {
  console.error(
    `argent-simulator-server: no binary for platform "${platformKey}" at ${binary}.\n` +
      `Supported hosts today: darwin, linux (x86_64 and arm64), win32.`
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// Forward termination signals so a supervisor that signals only the dispatcher
// PID (systemd, `kill -TERM <pid>`, container stop) doesn't orphan the child.
// A TTY Ctrl+C already reaches the whole process group.
/** @type {NodeJS.Signals[]} */
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
for (const sig of FORWARDED_SIGNALS) {
  process.on(sig, () => {
    if (!child.killed) {
      try {
        child.kill(sig);
      } catch {
        // Child already exited between the signal arriving and forwarding.
      }
    }
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
child.on("error", (err) => {
  console.error(`argent-simulator-server: failed to spawn ${binary}: ${err.message}`);
  process.exit(1);
});
