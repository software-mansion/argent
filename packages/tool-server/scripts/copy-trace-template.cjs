#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Copies the iOS profiler Argent.tracetemplate into dist/ next to its compiled
 * consumer. Replaces the previous `cp` shell call so the build runs on
 * Windows too. The file is iOS-only payload but the build is
 * platform-agnostic — copying it on Windows is harmless (no iOS profiler
 * code path will ever invoke it there).
 */

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.resolve(__dirname, "..", "src/utils/ios-profiler/Argent.tracetemplate");
const DEST_DIR = path.resolve(__dirname, "..", "dist/utils/ios-profiler");
const DEST = path.join(DEST_DIR, "Argent.tracetemplate");

fs.mkdirSync(DEST_DIR, { recursive: true });
fs.cpSync(SRC, DEST, { recursive: true });
