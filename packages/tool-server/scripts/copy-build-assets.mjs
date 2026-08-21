#!/usr/bin/env node
// Copy the non-TypeScript files `tsc` leaves behind into dist/, at the same
// path they have under src/ — `src/` itself is stripped, so `src/a/b.mjs`
// becomes `dist/a/b.mjs`, mirroring what `tsc` does with a `.ts` beside it.
//
// That layout is what the runtime lookups assume. The runner is resolved from
// the compiled executor's own `__dirname`, and the two watchdogs from the
// runner's `import.meta.url`; the Instruments template is looked up by relative
// depth from the module that needs it, which has two candidates because that
// depth differs between the bundle and a dev tree.
//
// The workspace `build` script runs this, which is what keeps it from being
// forgotten: `packages/tool-server/dist` is booted as a real tool server by CI.
// No flow `script` step exists yet, so today a short dist ships unreachable
// payload; from the PR that wires the step up, it fails every one of them at
// flow-execute time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Source paths, relative to the package root. Each is copied to dist/<same path minus src/>. */
const ASSETS = [
  // Instruments template for iOS native profiling.
  "src/utils/ios-profiler/Argent.tracetemplate",
  // The flow `script` child process and its two watchdog threads. The
  // tool-server package sets no `allowJs`, so `tsc` skips a `.mjs` whether or
  // not anything imports it.
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
