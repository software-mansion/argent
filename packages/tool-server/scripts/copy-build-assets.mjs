#!/usr/bin/env node
// dist must mirror src exactly: the compiled executor resolves the runner from
// its own `__dirname`, the runner resolves both watchdogs from its
// `import.meta.url`, and the Instruments template by relative depth.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ASSETS = [
  "src/utils/ios-profiler/Argent.tracetemplate",
  // `tsc` skips a `.mjs` whether or not anything imports it: no `allowJs`.
  "src/tools/flows/script/flow-script-runner.mjs",
  "src/tools/flows/script/flow-script-watchdog-lifeline.mjs",
  "src/tools/flows/script/flow-script-watchdog-deadline.mjs",
];

for (const asset of ASSETS) {
  const from = path.join(packageRoot, asset);
  const to = path.join(packageRoot, "dist", path.relative("src", asset));
  if (!fs.existsSync(from)) {
    throw new Error(`Build asset missing: ${from}`);
  }
  fs.cpSync(from, to);
}

console.log(`Copied ${ASSETS.length} build assets into dist/`);
