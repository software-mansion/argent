#!/usr/bin/env node
// @ts-check
"use strict";

// Boots the downloaded Perfetto trace-processor engine on an empty trace and
// runs one query. scripts/download-trace-processor.sh fetches the glue from the
// newest argent-private build, not from a pinned version, so the glue can drift
// from the anchors in patchGlueForNode. This fails the build when it does,
// instead of shipping a package whose Android analysis can't load.
//
// Run after `npm run build` (it loads packages/native-devtools-android/dist).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  queryWarm,
  PERFETTO_VERSION,
} = require("../packages/native-devtools-android/dist/index.js");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-trace-processor-check-"));
  const tracePath = path.join(dir, "empty.pftrace");
  fs.writeFileSync(tracePath, "");
  try {
    const rows = await queryWarm(tracePath, "select 1 as ok");
    if (rows.length !== 1 || rows[0].ok !== 1) {
      throw new Error(`unexpected result: ${JSON.stringify(rows)}`);
    }
    console.log(`✓ Perfetto trace-processor engine loads (stamped ${PERFETTO_VERSION})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Exit explicitly: the engine's MessagePort keeps the event loop alive.
main().then(
  () => process.exit(0),
  (err) => {
    console.error("✗ Perfetto trace-processor engine failed to load:");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
