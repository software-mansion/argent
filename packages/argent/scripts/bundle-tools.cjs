#!/usr/bin/env node
"use strict";

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");

// esbuild entry points (source) and bundle outputs.
const TOOLS_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/tool-server/src/index.ts");
const REGISTRY_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/registry/src/index.ts");
const NATIVE_DEVTOOLS_IOS_ENTRY = path.resolve(
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

// Shared aliases so each bundle resolves workspace deps from source. Resolving
// from source (rather than each package's compiled dist/) keeps the bundle
// independent of build order/freshness.
const ALIASES = {
  "@argent/registry": REGISTRY_ENTRY,
  "@argent/native-devtools-ios": NATIVE_DEVTOOLS_IOS_ENTRY,
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

// ── Asset source/destination paths ─────────────────────────────────────────
const BIN_DIR = path.resolve(__dirname, "../bin");
const BIN_SRC = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-ios/bin/simulator-server");
const BIN_DEST = path.resolve(__dirname, "../bin/simulator-server");
const AX_BIN_SRC = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-ios/bin/ax-service");
const AX_BIN_DEST = path.resolve(__dirname, "../bin/ax-service");
const TP_BIN_SRC = path.resolve(
  WORKSPACE_ROOT,
  "packages/native-devtools-android/bin/trace_processor_shell"
);
const TP_BIN_DEST = path.resolve(__dirname, "../bin/trace_processor_shell");
const DYLIBS_SRC = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-ios/dylibs");
const DYLIBS_DEST = path.resolve(__dirname, "../dylibs");
const SKILLS_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/skills");
const SKILLS_DEST = path.resolve(__dirname, "../skills");
const RULES_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/rules");
const RULES_DEST = path.resolve(__dirname, "../rules");
const AGENTS_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/agents");
const AGENTS_DEST = path.resolve(__dirname, "../agents");
const QUERIES_SRC = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-android/queries");
const QUERIES_DEST = path.resolve(__dirname, "../queries");
const ANDROID_PKG_DIR = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-android");
const ANDROID_MANIFEST_SRC = path.join(ANDROID_PKG_DIR, "manifest.json");
const ANDROID_MANIFEST_DEST = path.resolve(__dirname, "../manifest.json");
const ANDROID_APK_DIST_SRC = path.join(ANDROID_PKG_DIR, "dist");
const ANDROID_APK_DEST_DIR = path.resolve(__dirname, "../dist");
const UI_SRC = path.resolve(WORKSPACE_ROOT, "packages/ui/index.html");
const UI_DEST = path.resolve(__dirname, "../dist/preview-ui/index.html");
const TRACE_TEMPLATE_SRC = path.resolve(
  WORKSPACE_ROOT,
  "packages/tool-server/src/utils/ios-profiler/Argent.tracetemplate"
);
const TRACE_TEMPLATE_DEST = path.resolve(__dirname, "../dist/Argent.tracetemplate");
const TRACECFG_SRC = path.resolve(
  WORKSPACE_ROOT,
  "packages/native-devtools-android/argent.tracecfg.pbtxt"
);
const TRACECFG_DEST = path.resolve(__dirname, "../argent.tracecfg.pbtxt");

// ── Asset table ─────────────────────────────────────────────────────────────
// Declarative copy plan. Each entry is copied (or its absence reported) by
// copyAsset() below. `required: true` throws on a missing source; otherwise
// copyAsset warns and skips. The per-asset required/optional decision is the
// whole point of keeping this table explicit.
//
//   kind        "file" (copyFileSync) | "dir" (cpSync recursive)
//   src/dest    absolute source and destination paths
//   mode        optional chmod applied to the copied file
//   required    throw (true) vs warn (false) when src is missing
//   copiedLabel text after "✓ Copied " on success (count is prefixed if set)
//   missLabel   subject of the "<X> not found at …" miss message
//   countExt    count src entries ending in this ext, shown before copiedLabel
//   count       custom counter (src) => number, takes precedence over countExt
//   hint        extra guidance appended to the throw message (required assets)
/**
 * @typedef {Object} Asset
 * @property {"file"|"dir"} kind
 * @property {string} src
 * @property {string} dest
 * @property {boolean} required
 * @property {string} copiedLabel
 * @property {string} missLabel
 * @property {number} [mode]
 * @property {string} [countExt]
 * @property {(src: string) => number} [count]
 * @property {string} [hint]
 */
/** @type {Asset[]} */
const ASSETS = [
  // iOS simulator-server binary (downloaded via scripts/download-simulator-server.sh).
  {
    kind: "file",
    src: BIN_SRC,
    dest: BIN_DEST,
    mode: 0o755,
    required: true,
    copiedLabel: "simulator-server binary",
    missLabel: "simulator-server binary",
    hint: "Run: bash scripts/download-simulator-server.sh",
  },
  // iOS ax-service binary.
  {
    kind: "file",
    src: AX_BIN_SRC,
    dest: AX_BIN_DEST,
    mode: 0o755,
    required: false,
    copiedLabel: "ax-service binary",
    missLabel: "ax-service binary",
  },
  // Android host-side Perfetto trace processor.
  {
    kind: "file",
    src: TP_BIN_SRC,
    dest: TP_BIN_DEST,
    mode: 0o755,
    required: true,
    copiedLabel: "trace_processor_shell binary",
    missLabel: "trace_processor_shell binary",
    hint:
      "Run: npm run pack:mcp (fetches from argent-private-releases)\n" +
      "or: bash scripts/download-native-binaries.sh",
  },
  // iOS native devtools dylibs so the packaged tool-server can inject them at runtime.
  {
    kind: "dir",
    src: DYLIBS_SRC,
    dest: DYLIBS_DEST,
    required: false,
    copiedLabel: "native dylib(s)",
    missLabel: "Native devtools dylibs",
    countExt: ".dylib",
  },
  // Android helper manifest.json. Required: helperManifest()/bundledHelperApkPath()
  // read it at runtime, and the version-stamped APK filename is derived from its
  // versionName (see the dedicated APK block after the copy loop).
  {
    kind: "file",
    src: ANDROID_MANIFEST_SRC,
    dest: ANDROID_MANIFEST_DEST,
    required: true,
    copiedLabel: "Android manifest",
    missLabel: "Android manifest",
    hint: "Run: bash scripts/download-native-binaries.sh (fetches from argent-private-releases)",
  },
  // Preview UI (@argent/ui) next to the bundled tool-server so that tool-server's
  // /preview/ endpoint can locate it via __dirname lookup.
  {
    kind: "file",
    src: UI_SRC,
    dest: UI_DEST,
    required: false,
    copiedLabel: "preview UI",
    missLabel: "Preview UI",
  },
  // Argent.tracetemplate so native-profiler-start (iOS) can find it at runtime.
  {
    kind: "file",
    src: TRACE_TEMPLATE_SRC,
    dest: TRACE_TEMPLATE_DEST,
    required: false,
    copiedLabel: "Argent.tracetemplate",
    missLabel: "Argent.tracetemplate",
  },
  // argent.tracecfg.pbtxt so the Android profiler capture step can find it at
  // runtime. capture.ts resolves the path via @argent/native-devtools-android's
  // `traceConfigPath()`, which does `path.join(__dirname, "..", "argent.tracecfg.pbtxt")`
  // — in the bundled tool-server.cjs that is `<pkg>/argent.tracecfg.pbtxt`,
  // i.e. this exact destination (sibling of dist/, not inside it).
  {
    kind: "file",
    src: TRACECFG_SRC,
    dest: TRACECFG_DEST,
    required: true,
    copiedLabel: "argent.tracecfg.pbtxt",
    missLabel: "argent.tracecfg.pbtxt",
    hint: "This file is required for Android native profiling.",
  },
  // Android profiler SQL queries. run-tp.ts resolves QUERY_DIR via
  // `path.resolve(__dirname, "..", "queries")` — in the bundled tool-server.cjs
  // that is `<pkg>/queries/`, i.e. this exact destination.
  {
    kind: "dir",
    src: QUERIES_SRC,
    dest: QUERIES_DEST,
    required: true,
    copiedLabel: "SQL queries",
    missLabel: "Android profiler queries directory",
    countExt: ".sql",
    hint: "This directory is required for native-profiler-analyze on Android.",
  },
  // Skills shipped on npm. Mirrors the full directory structure from
  // packages/skills/skills/ (e.g. metro-debugger/SKILL.md,
  // metro-debugger/references/source-maps.md, …).
  {
    kind: "dir",
    src: SKILLS_SRC,
    dest: SKILLS_DEST,
    required: false,
    copiedLabel: "skill(s)",
    missLabel: "Skills source",
    count: (src) =>
      fs.readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).length,
  },
  // Rules shipped on npm.
  {
    kind: "dir",
    src: RULES_SRC,
    dest: RULES_DEST,
    required: false,
    copiedLabel: "rule(s)",
    missLabel: "Rules source",
    countExt: ".md",
  },
  // Agents shipped on npm.
  {
    kind: "dir",
    src: AGENTS_SRC,
    dest: AGENTS_DEST,
    required: false,
    copiedLabel: "agent(s)",
    missLabel: "Agents source",
    count: (src) =>
      fs
        .readdirSync(src, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md")).length,
  },
];

/**
 * Bundle a single entry point with esbuild and log the result.
 * @param {{ entry: string, out: string, format: "cjs" | "esm", label: string }} opts
 */
function buildBundle({ entry, out, format, label }) {
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node22",
    format,
    outfile: out,
    alias: ALIASES,
    mainFields: MAIN_FIELDS,
    // ESM bundles need the require() shim (for inlined CJS deps) and must keep
    // node: builtins external; the CJS bundle needs neither.
    ...(format === "esm" ? { banner: ESM_REQUIRE_BANNER, external: ["node:*"] } : {}),
  });
  console.log(`✓ Bundled ${label} → ${path.relative(process.cwd(), out)}`);
}

/**
 * Resolve the count shown in the success line, or null when the asset isn't
 * counted (`count` takes precedence over `countExt`).
 * @param {Asset} a
 * @returns {number | null}
 */
function assetCount(a) {
  if (a.count) return a.count(a.src);
  if (a.countExt) {
    const ext = a.countExt;
    return fs.readdirSync(a.src).filter((f) => f.endsWith(ext)).length;
  }
  return null;
}

/**
 * Copy one ASSETS entry, throwing or warning per its `required` flag.
 * @param {Asset} a
 */
function copyAsset(a) {
  if (!fs.existsSync(a.src)) {
    if (a.required) {
      throw new Error(`${a.missLabel} not found at ${a.src}.` + (a.hint ? `\n${a.hint}` : ""));
    }
    console.warn(`⚠ ${a.missLabel} not found at ${a.src} — skipping copy`);
    return;
  }

  if (a.kind === "dir") {
    fs.cpSync(a.src, a.dest, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(a.dest), { recursive: true });
    fs.copyFileSync(a.src, a.dest);
  }
  if (a.mode != null) fs.chmodSync(a.dest, a.mode);

  const rel = path.relative(process.cwd(), a.dest);
  const count = assetCount(a);
  if (count != null) {
    console.log(`✓ Copied ${count} ${a.copiedLabel} → ${rel}`);
  } else {
    console.log(`✓ Copied ${a.copiedLabel} → ${rel}`);
  }
}

// Purge artifact directories so stale files don't survive across builds. Derived
// from the table (every dir-kind destination, plus BIN_DIR) so it can't drift.
const PURGE_DIRS = [BIN_DIR, ...ASSETS.filter((a) => a.kind === "dir").map((a) => a.dest)];
for (const dir of PURGE_DIRS) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// Ensure dist/ exists
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

// Bundle the tools server (CJS — the dispatcher loads it via require()).
buildBundle({ entry: TOOLS_ENTRY, out: OUT_FILE, format: "cjs", label: "tools server" });

// The remaining bundles are ESM so that:
//   - installer: import.meta.dirname works at runtime (the dispatcher
//     lazy-imports it, so its workspace dep needn't resolve in the published pkg);
//   - MCP server: the @modelcontextprotocol/sdk ESM export paths resolve;
//   - CLI commands: the tools/run/server subcommands share the same toolchain.
const ESM_BUNDLES = [
  { entry: INSTALLER_ENTRY, out: INSTALLER_OUT_FILE, label: "installer" },
  { entry: MCP_ENTRY, out: MCP_OUT_FILE, label: "MCP server" },
  { entry: CLI_ENTRY, out: CLI_OUT_FILE, label: "CLI commands" },
];
for (const b of ESM_BUNDLES) {
  buildBundle({ ...b, format: "esm" });
}

// Copy all declared assets.
for (const a of ASSETS) {
  copyAsset(a);
}

// Copy the Android helper APK. Its filename is version-stamped from manifest.json's
// versionName (see bundledHelperApkPath()); manifest.json was copied as a required
// asset above, so its source is guaranteed present here. The APK is likewise
// required at runtime, so a missing APK throws (matching the sibling Android assets).
const manifest = JSON.parse(fs.readFileSync(ANDROID_MANIFEST_SRC, "utf8"));
const apkName = `argent-android-devtools-${manifest.versionName}.apk`;
const apkSrc = path.join(ANDROID_APK_DIST_SRC, apkName);
if (fs.existsSync(apkSrc)) {
  fs.copyFileSync(apkSrc, path.join(ANDROID_APK_DEST_DIR, apkName));
  console.log(
    `✓ Copied Android helper APK → ${path.relative(process.cwd(), ANDROID_APK_DEST_DIR)}/${apkName}`
  );
} else {
  throw new Error(
    `Android helper APK not found at ${apkSrc}.\n` +
      `Run: bash scripts/download-native-binaries.sh (fetches from argent-private-releases)\n` +
      `or: bash packages/native-devtools-android/scripts/build.sh`
  );
}
