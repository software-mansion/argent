#!/usr/bin/env node
// @ts-check
"use strict";

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");
const TOOLS_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/tool-server/src/index.ts");
const REGISTRY_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/registry/src/index.ts");
const OUT_FILE = path.resolve(__dirname, "../dist/tool-server.cjs");
const BIN_SRC = path.resolve(WORKSPACE_ROOT, "simulator-server");
const BIN_DEST = path.resolve(__dirname, "../bin/simulator-server");
const SKILLS_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/skills");
const SKILLS_DEST = path.resolve(__dirname, "../skills");

// Ensure dist/ exists
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

// Bundle the tools server
esbuild.buildSync({
  entryPoints: [TOOLS_ENTRY],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: OUT_FILE,
  alias: { "@radon-lite/registry": REGISTRY_ENTRY },
});

console.log(`✓ Bundled tools server → ${path.relative(process.cwd(), OUT_FILE)}`);

// Copy simulator-server binary
const BIN_DIR = path.dirname(BIN_DEST);
fs.mkdirSync(BIN_DIR, { recursive: true });

if (fs.existsSync(BIN_SRC)) {
  fs.copyFileSync(BIN_SRC, BIN_DEST);
  fs.chmodSync(BIN_DEST, 0o755);
  console.log(`✓ Copied simulator-server binary → ${path.relative(process.cwd(), BIN_DEST)}`);
} else {
  console.warn(`⚠ simulator-server binary not found at ${BIN_SRC} — skipping copy`);
}

// Copy skill files into the package so they ship on npm
fs.mkdirSync(SKILLS_DEST, { recursive: true });
if (fs.existsSync(SKILLS_SRC)) {
  for (const file of fs.readdirSync(SKILLS_SRC)) {
    if (file.endsWith(".md")) {
      fs.copyFileSync(path.join(SKILLS_SRC, file), path.join(SKILLS_DEST, file));
    }
  }
  console.log(`✓ Copied skill files → ${path.relative(process.cwd(), SKILLS_DEST)}`);
} else {
  console.warn(`⚠ Skills source not found at ${SKILLS_SRC} — skipping copy`);
}
