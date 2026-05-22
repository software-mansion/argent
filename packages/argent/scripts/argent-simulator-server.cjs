#!/usr/bin/env node
"use strict";

// Thin dispatcher exposed as the `argent-simulator-server` bin entry in
// package.json. Picks the platform-specific simulator-server binary at
// invocation time and execs it with the caller's args. Required because
// npm's `bin` field resolves to a single file regardless of host platform,
// but the binary itself is platform-specific (Mach-O for darwin, ELF for
// linux). The native-devtools-ios resolver uses the same per-platform
// subdirectory layout, so a stable layout lives in exactly one place.

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const binary = path.join(__dirname, process.platform, "simulator-server");
if (!fs.existsSync(binary)) {
  console.error(
    `argent-simulator-server: no binary for platform "${process.platform}" at ${binary}.\n` +
      `Supported hosts today: darwin, linux.`
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
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
