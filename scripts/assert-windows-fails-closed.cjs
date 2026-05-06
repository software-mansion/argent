#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * CI assertion: on Windows, `simulatorServerBinaryPath()` must throw,
 * because `simulator-server.exe` is intentionally NOT shipped (the
 * upstream argent-stripped Windows variant doesn't exist yet — see
 * `scripts/download-simulator-server.cjs` for the rationale).
 *
 * Asserting the exact failure mode here means a future regression that
 * silently re-introduced the vanilla binary would surface as a
 * *passing* simulator path, not as silent feature drift.
 *
 * Exits 0 when the resolver fails closed with the expected message;
 * exits 1 with a diagnostic on any other outcome.
 */

const path = require("node:path");

if (process.platform !== "win32") {
  console.log(`skipped — assertion is Windows-only (current platform: ${process.platform})`);
  process.exit(0);
}

// Point the resolver at the real bundled `bin/` directory so it sees
// what an end-user would see post-install.
process.env.ARGENT_SIMULATOR_SERVER_DIR ??= path.resolve(__dirname, "..", "packages/argent/bin");

const mod = require(path.resolve(__dirname, "..", "packages/native-devtools-ios/dist/index.js"));

try {
  mod.simulatorServerBinaryPath();
  console.error("REGRESSION: simulatorServerBinaryPath() did not throw on Windows");
  process.exit(1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("simulator-server")) {
    console.error(`unexpected error: ${msg}`);
    process.exit(1);
  }
  console.log(`OK fail-closed: ${msg}`);
}
