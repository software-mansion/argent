#!/usr/bin/env node
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
const NATIVE_DEVTOOLS_ANDROID_ENTRY = path.resolve(
  WORKSPACE_ROOT,
  "packages/native-devtools-android/src/index.ts"
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
  "@argent/native-devtools-android": NATIVE_DEVTOOLS_ANDROID_ENTRY,
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
// Source layout mirrors what `scripts/download-simulator-server.sh` writes:
// platform-keyed subdirectories of bin/, each containing one simulator-server
// binary. ax-service is macOS-only (it spawns inside an iOS Simulator), so it
// only lives under darwin/.
const BIN_SRC_ROOT = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-ios/bin");
const AX_BIN_SRC = path.resolve(BIN_SRC_ROOT, "darwin/ax-service");
const AX_TCP_BIN_SRC = path.resolve(BIN_SRC_ROOT, "darwin/tcp/ax-service");
const BIN_DIR = path.resolve(__dirname, "../bin");
const AX_BIN_DEST = path.resolve(BIN_DIR, "darwin/ax-service");
const AX_TCP_BIN_DEST = path.resolve(BIN_DIR, "darwin/tcp/ax-service");
const SUPPORTED_HOST_PLATFORMS = ["darwin", "linux"];
const DYLIBS_SRC = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-ios/dylibs");
const DYLIBS_DEST = path.resolve(__dirname, "../dylibs");
const SKILLS_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/skills");
const SKILLS_DEST = path.resolve(__dirname, "../skills");
const RULES_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/rules");
const RULES_DEST = path.resolve(__dirname, "../rules");
const AGENTS_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/agents");
const AGENTS_DEST = path.resolve(__dirname, "../agents");
const ANDROID_PKG_DIR = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-android");
const ANDROID_MANIFEST_SRC = path.join(ANDROID_PKG_DIR, "manifest.json");
const ANDROID_MANIFEST_DEST = path.resolve(__dirname, "../manifest.json");
const ANDROID_APK_DIST_SRC = path.join(ANDROID_PKG_DIR, "dist");
const ANDROID_APK_DEST_DIR = path.resolve(__dirname, "../dist");

// Purge artifact directories so stale files don't survive across builds.
for (const dir of [BIN_DIR, DYLIBS_DEST, SKILLS_DEST, RULES_DEST, AGENTS_DEST]) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// Copy the hand-written `argent-simulator-server` dispatcher into bin/.
// It's the file npm's `bin` field publishes; its job is to pick the right
// per-platform binary at invocation time. Source lives in scripts/ so it
// isn't entangled with the gitignored bundle output under bin/.
const DISPATCHER_SRC = path.resolve(__dirname, "argent-simulator-server.cjs");
const DISPATCHER_DEST = path.resolve(BIN_DIR, "argent-simulator-server.cjs");
fs.copyFileSync(DISPATCHER_SRC, DISPATCHER_DEST);
fs.chmodSync(DISPATCHER_DEST, 0o755);

// The Android helper artifacts live alongside the bundles (manifest at the
// package root, APK inside the shared dist/ folder) so they aren't covered
// by the per-directory purge above. Removing them explicitly keeps a
// missing-APK rebuild from leaving a stale manifest behind that would later
// fool helperManifest() into pointing at an APK that's no longer present.
fs.rmSync(ANDROID_MANIFEST_DEST, { force: true });
if (fs.existsSync(ANDROID_APK_DEST_DIR)) {
  for (const entry of fs.readdirSync(ANDROID_APK_DEST_DIR)) {
    if (/^argent-android-devtools-.*\.apk$/.test(entry)) {
      fs.rmSync(path.join(ANDROID_APK_DEST_DIR, entry), { force: true });
    }
  }
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

// Copy simulator-server for every supported host platform that's present in
// the staging area. Require the darwin binary only when bundling ON darwin
// (the publish pipeline) — a Linux contributor running `npm run pack` locally
// can't produce the macOS binary, so don't block them on its absence.
for (const platform of SUPPORTED_HOST_PLATFORMS) {
  const src = path.join(BIN_SRC_ROOT, platform, "simulator-server");
  const destDir = path.join(BIN_DIR, platform);
  const dest = path.join(destDir, "simulator-server");
  if (fs.existsSync(src)) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
    console.log(`✓ Copied simulator-server (${platform}) → ${path.relative(process.cwd(), dest)}`);
  } else if (platform === "darwin" && process.platform === "darwin") {
    throw new Error(
      `simulator-server binary not found at ${src}.\n` +
        `Run: bash scripts/download-simulator-server.sh`
    );
  } else {
    console.warn(`⚠ simulator-server (${platform}) not found at ${src} — skipping`);
  }
}

// Copy ax-service binary (macOS-only — it runs inside an iOS Simulator)
if (fs.existsSync(AX_BIN_SRC)) {
  fs.mkdirSync(path.dirname(AX_BIN_DEST), { recursive: true });
  fs.copyFileSync(AX_BIN_SRC, AX_BIN_DEST);
  fs.chmodSync(AX_BIN_DEST, 0o755);
  console.log(`✓ Copied ax-service binary → ${path.relative(process.cwd(), AX_BIN_DEST)}`);
} else {
  console.warn(`⚠ ax-service binary not found at ${AX_BIN_SRC} — skipping copy`);
}

// Copy ax-service TCP variant (darwin/tcp/ax-service). Best-effort: only
// present when the TCP transport was built; skip without error if absent.
if (fs.existsSync(AX_TCP_BIN_SRC)) {
  fs.mkdirSync(path.dirname(AX_TCP_BIN_DEST), { recursive: true });
  fs.copyFileSync(AX_TCP_BIN_SRC, AX_TCP_BIN_DEST);
  fs.chmodSync(AX_TCP_BIN_DEST, 0o755);
  console.log(
    `✓ Copied ax-service (tcp) binary → ${path.relative(process.cwd(), AX_TCP_BIN_DEST)}`
  );
} else {
  console.warn(`⚠ ax-service (tcp) binary not found at ${AX_TCP_BIN_SRC} — skipping copy`);
}

// Copy native devtools dylibs so the packaged tool-server can inject them at runtime.
if (fs.existsSync(DYLIBS_SRC)) {
  fs.cpSync(DYLIBS_SRC, DYLIBS_DEST, { recursive: true });
  const count = fs.readdirSync(DYLIBS_SRC).filter((f) => f.endsWith(".dylib")).length;
  console.log(`✓ Copied ${count} native dylib(s) → ${path.relative(process.cwd(), DYLIBS_DEST)}`);
} else {
  console.warn(`⚠ Native devtools dylibs not found at ${DYLIBS_SRC} — skipping copy`);
}

// Copy the Android helper APK + its manifest.json into the published package.
if (fs.existsSync(ANDROID_MANIFEST_SRC)) {
  const manifest = JSON.parse(fs.readFileSync(ANDROID_MANIFEST_SRC, "utf8"));
  const apkName = `argent-android-devtools-${manifest.versionName}.apk`;
  const apkSrc = path.join(ANDROID_APK_DIST_SRC, apkName);
  if (fs.existsSync(apkSrc)) {
    fs.copyFileSync(ANDROID_MANIFEST_SRC, ANDROID_MANIFEST_DEST);
    fs.copyFileSync(apkSrc, path.join(ANDROID_APK_DEST_DIR, apkName));
    console.log(
      `✓ Copied Android helper APK + manifest → ${path.relative(process.cwd(), ANDROID_APK_DEST_DIR)}/${apkName}`
    );
  } else {
    console.warn(
      `⚠ Android helper APK not found at ${apkSrc} — run ` +
        `\`bash packages/native-devtools-android/scripts/build.sh\` ` +
        `or \`bash scripts/download-native-binaries.sh\` first`
    );
  }
} else {
  console.warn(`⚠ Android manifest not found at ${ANDROID_MANIFEST_SRC} — skipping copy`);
}

// Copy preview UI (@argent/ui) next to the bundled tool-server so that
// tool-server's /preview/ endpoint can locate it via __dirname lookup.
// index.html AND its externalised theme.css must both ship — a partial copy
// would 404 /preview/theme.css and serve an unstyled UI.
const UI_SRC_DIR = path.resolve(WORKSPACE_ROOT, "packages/ui");
const UI_DEST_DIR = path.resolve(__dirname, "../dist/preview-ui");
const UI_ASSETS = ["index.html", "theme.css"];

if (fs.existsSync(path.join(UI_SRC_DIR, "index.html"))) {
  fs.mkdirSync(UI_DEST_DIR, { recursive: true });
  for (const asset of UI_ASSETS) {
    fs.copyFileSync(path.join(UI_SRC_DIR, asset), path.join(UI_DEST_DIR, asset));
  }
  console.log(
    `✓ Copied preview UI (${UI_ASSETS.join(", ")}) → ${path.relative(process.cwd(), UI_DEST_DIR)}`
  );
} else {
  console.warn(`⚠ Preview UI not found at ${UI_SRC_DIR} — skipping copy`);
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
