#!/usr/bin/env node
// @ts-check
"use strict";

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");
const TOOLS_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/tool-server/src/index.ts");
const REGISTRY_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/registry/src/index.ts");
const NATIVE_DEVTOOLS_ENTRY = path.resolve(
  WORKSPACE_ROOT,
  "packages/native-devtools-ios/src/index.ts"
);
const TOOLS_CLIENT_ENTRY = path.resolve(
  WORKSPACE_ROOT,
  "packages/argent-tools-client/src/index.ts"
);
const INSTALLER_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/argent-installer/src/index.ts");
const MCP_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/argent-mcp/src/index.ts");
const CLI_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/argent-cli/src/index.ts");
const OUT_FILE = path.resolve(__dirname, "../dist/tool-server.cjs");
const INSTALLER_OUT_FILE = path.resolve(__dirname, "../dist/installer.mjs");
const MCP_OUT_FILE = path.resolve(__dirname, "../dist/mcp-server.mjs");
const CLI_OUT_FILE = path.resolve(__dirname, "../dist/cli-cmds.mjs");

// Shared aliases so each bundle resolves workspace deps from source.
const ALIASES = {
  "@argent/registry": REGISTRY_ENTRY,
  "@argent/native-devtools-ios": NATIVE_DEVTOOLS_ENTRY,
  "@argent/tools-client": TOOLS_CLIENT_ENTRY,
  "@argent/installer": INSTALLER_ENTRY,
  "@argent/mcp": MCP_ENTRY,
  "@argent/cli": CLI_ENTRY,
};

// esbuild on platform:"node" defaults mainFields to ["main","module"], which
// picks UMD entries that use runtime `require("./impl/...")`. Those requires
// can't be statically resolved during bundling and fail at runtime because
// the impl/ folder isn't shipped next to the bundle. Prefer "module" so we
// pick ESM entries with static imports that get fully inlined. Affects e.g.
// jsonc-parser, which ships both UMD (main) and ESM (module).
const MAIN_FIELDS = ["module", "main"];

// Banner injected into ESM bundles so any inlined CJS dependencies that call
// `require()` work without a real CJS context.
const ESM_REQUIRE_BANNER = {
  js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
};
const BIN_SRC = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-ios/bin/simulator-server");
const BIN_DEST = path.resolve(__dirname, "../bin/simulator-server");
const AX_BIN_SRC = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-ios/bin/ax-service");
const AX_BIN_DEST = path.resolve(__dirname, "../bin/ax-service");
const BIN_DIR = path.resolve(__dirname, "../bin");
const DYLIBS_SRC = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-ios/dylibs");
const DYLIBS_DEST = path.resolve(__dirname, "../dylibs");
const SKILLS_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/skills");
const SKILLS_DEST = path.resolve(__dirname, "../skills");
const RULES_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/rules");
const RULES_DEST = path.resolve(__dirname, "../rules");
const AGENTS_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/agents");
const AGENTS_DEST = path.resolve(__dirname, "../agents");

// Purge artifact directories so stale files don't survive across builds.
for (const dir of [BIN_DIR, DYLIBS_DEST, SKILLS_DEST, RULES_DEST, AGENTS_DEST]) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

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
  alias: ALIASES,
  mainFields: MAIN_FIELDS,
});

console.log(`✓ Bundled tools server → ${path.relative(process.cwd(), OUT_FILE)}`);

// Bundle the installer (init/update/uninstall) as ESM so import.meta.dirname
// works at runtime. The dispatcher lazy-imports this bundle so the workspace
// dep doesn't need to be resolvable in the published package.
esbuild.buildSync({
  entryPoints: [INSTALLER_ENTRY],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: INSTALLER_OUT_FILE,
  alias: ALIASES,
  banner: ESM_REQUIRE_BANNER,
  external: ["node:*"],
  mainFields: MAIN_FIELDS,
});

console.log(`✓ Bundled installer → ${path.relative(process.cwd(), INSTALLER_OUT_FILE)}`);

// Bundle the MCP stdio server. ESM so the @modelcontextprotocol/sdk imports
// (which use ESM exports paths) resolve correctly.
esbuild.buildSync({
  entryPoints: [MCP_ENTRY],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: MCP_OUT_FILE,
  alias: ALIASES,
  banner: ESM_REQUIRE_BANNER,
  external: ["node:*"],
  mainFields: MAIN_FIELDS,
});

console.log(`✓ Bundled MCP server → ${path.relative(process.cwd(), MCP_OUT_FILE)}`);

// Bundle the CLI subcommands (tools/run/server).
esbuild.buildSync({
  entryPoints: [CLI_ENTRY],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: CLI_OUT_FILE,
  alias: ALIASES,
  banner: ESM_REQUIRE_BANNER,
  external: ["node:*"],
  mainFields: MAIN_FIELDS,
});

console.log(`✓ Bundled CLI commands → ${path.relative(process.cwd(), CLI_OUT_FILE)}`);

// Copy simulator-server binary (downloaded via scripts/download-simulator-server.sh)
if (fs.existsSync(BIN_SRC)) {
  fs.copyFileSync(BIN_SRC, BIN_DEST);
  fs.chmodSync(BIN_DEST, 0o755);
  console.log(`✓ Copied simulator-server binary → ${path.relative(process.cwd(), BIN_DEST)}`);
} else {
  throw new Error(
    `simulator-server binary not found at ${BIN_SRC}.\n` +
      `Run: bash scripts/download-simulator-server.sh`
  );
}

// Copy ax-service binary
if (fs.existsSync(AX_BIN_SRC)) {
  fs.copyFileSync(AX_BIN_SRC, AX_BIN_DEST);
  fs.chmodSync(AX_BIN_DEST, 0o755);
  console.log(`✓ Copied ax-service binary → ${path.relative(process.cwd(), AX_BIN_DEST)}`);
} else {
  console.warn(`⚠ ax-service binary not found at ${AX_BIN_SRC} — skipping copy`);
}

// Copy native devtools dylibs so the packaged tool-server can inject them at runtime.
if (fs.existsSync(DYLIBS_SRC)) {
  fs.cpSync(DYLIBS_SRC, DYLIBS_DEST, { recursive: true });
  const count = fs.readdirSync(DYLIBS_SRC).filter((f) => f.endsWith(".dylib")).length;
  console.log(`✓ Copied ${count} native dylib(s) → ${path.relative(process.cwd(), DYLIBS_DEST)}`);
} else {
  console.warn(`⚠ Native devtools dylibs not found at ${DYLIBS_SRC} — skipping copy`);
}

// Copy preview UI (@argent/ui) next to the bundled tool-server so that
// tool-server's /preview/ endpoint can locate it via __dirname lookup.
const UI_SRC = path.resolve(WORKSPACE_ROOT, "packages/ui/index.html");
const UI_DEST_DIR = path.resolve(__dirname, "../dist/preview-ui");
const UI_DEST = path.join(UI_DEST_DIR, "index.html");

if (fs.existsSync(UI_SRC)) {
  fs.mkdirSync(UI_DEST_DIR, { recursive: true });
  fs.copyFileSync(UI_SRC, UI_DEST);
  console.log(`✓ Copied preview UI → ${path.relative(process.cwd(), UI_DEST)}`);
} else {
  console.warn(`⚠ Preview UI not found at ${UI_SRC} — skipping copy`);
}

// Copy Argent.tracetemplate so native-profiler-start can find it at runtime.
const TRACE_TEMPLATE_SRC = path.resolve(
  WORKSPACE_ROOT,
  "packages/tool-server/src/utils/ios-profiler/Argent.tracetemplate"
);
const TRACE_TEMPLATE_DEST = path.resolve(__dirname, "../dist/Argent.tracetemplate");

if (fs.existsSync(TRACE_TEMPLATE_SRC)) {
  fs.copyFileSync(TRACE_TEMPLATE_SRC, TRACE_TEMPLATE_DEST);
  console.log(
    `✓ Copied Argent.tracetemplate → ${path.relative(process.cwd(), TRACE_TEMPLATE_DEST)}`
  );
} else {
  console.warn(`⚠ Argent.tracetemplate not found at ${TRACE_TEMPLATE_SRC} — skipping copy`);
}

// Copy skills into the package so they ship on npm.
// Mirrors the full directory structure from packages/skills/skills/
// (e.g. metro-debugger/SKILL.md, metro-debugger/references/source-maps.md, …)
if (fs.existsSync(SKILLS_SRC)) {
  fs.cpSync(SKILLS_SRC, SKILLS_DEST, { recursive: true });
  const count = fs
    .readdirSync(SKILLS_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory()).length;
  console.log(`✓ Copied ${count} skill(s) → ${path.relative(process.cwd(), SKILLS_DEST)}`);
} else {
  console.warn(`⚠ Skills source not found at ${SKILLS_SRC} — skipping copy`);
}

// Copy rules into the package so they ship on npm.
if (fs.existsSync(RULES_SRC)) {
  fs.cpSync(RULES_SRC, RULES_DEST, { recursive: true });
  const count = fs.readdirSync(RULES_SRC).filter((f) => f.endsWith(".md")).length;
  console.log(`✓ Copied ${count} rule(s) → ${path.relative(process.cwd(), RULES_DEST)}`);
} else {
  console.warn(`⚠ Rules source not found at ${RULES_SRC} — skipping copy`);
}

// Copy agents into the package so they ship on npm.
if (fs.existsSync(AGENTS_SRC)) {
  fs.cpSync(AGENTS_SRC, AGENTS_DEST, { recursive: true });
  const count = fs
    .readdirSync(AGENTS_SRC, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md")).length;
  console.log(`✓ Copied ${count} agent(s) → ${path.relative(process.cwd(), AGENTS_DEST)}`);
} else {
  console.warn(`⚠ Agents source not found at ${AGENTS_SRC} — skipping copy`);
}
