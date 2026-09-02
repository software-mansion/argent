#!/usr/bin/env node
"use strict";

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");

const TOOLS_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/tool-server/src/index.ts");
const ARCHIVE_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/archive/src/index.ts");
const REGISTRY_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/registry/src/index.ts");
const TELEMETRY_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/telemetry/src/index.ts");
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
const PREVIEW_WINDOW_ENTRY = path.resolve(WORKSPACE_ROOT, "packages/preview-window/src/main.ts");
const CONFIGURATION_ENTRY = path.resolve(
  WORKSPACE_ROOT,
  "packages/configuration-core/src/index.ts"
);
const OUT_FILE = path.resolve(__dirname, "../dist/tool-server.cjs");
const INSTALLER_OUT_FILE = path.resolve(__dirname, "../dist/installer.mjs");
const MCP_OUT_FILE = path.resolve(__dirname, "../dist/mcp-server.mjs");
const CLI_OUT_FILE = path.resolve(__dirname, "../dist/cli-cmds.mjs");
const PREVIEW_WINDOW_OUT_FILE = path.resolve(__dirname, "../dist/preview-window/main.cjs");

// Resolve workspace deps from source rather than each package's compiled dist/,
// so bundles don't depend on build order or freshness.
const ALIASES = {
  "@argent/archive": ARCHIVE_ENTRY,
  "@argent/registry": REGISTRY_ENTRY,
  "@argent/native-devtools-ios": NATIVE_DEVTOOLS_IOS_ENTRY,
  "@argent/native-devtools-android": NATIVE_DEVTOOLS_ANDROID_ENTRY,
  "@argent/tools-client": TOOLS_CLIENT_ENTRY,
  "@argent/installer": INSTALLER_ENTRY,
  "@argent/mcp": MCP_ENTRY,
  "@argent/cli": CLI_ENTRY,
  "@argent/configuration-core": CONFIGURATION_ENTRY,
  "@argent/telemetry": TELEMETRY_ENTRY,
};

// Build-time constants for @argent/telemetry. An unset ARGENT_OTEL_INGEST_TOKEN
// defines "", which leaves the telemetry client unconstructed and telemetry
// inert (see packages/telemetry/src/otel.ts).
const TELEMETRY_CLI_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

const TELEMETRY_OTEL_INGEST_TOKEN = process.env.ARGENT_OTEL_INGEST_TOKEN ?? "";

const TELEMETRY_DEFINE = {
  ARGENT_CLI_VERSION: JSON.stringify(TELEMETRY_CLI_VERSION),
  ARGENT_OTEL_INGEST_TOKEN: JSON.stringify(TELEMETRY_OTEL_INGEST_TOKEN),
};

// Prefer "module" over esbuild's node default ["main","module"]: UMD entries
// (e.g. jsonc-parser's) use runtime `require("./impl/...")` that can't be
// statically resolved, and impl/ isn't shipped next to the bundle.
const MAIN_FIELDS = ["module", "main"];

// Lets inlined CJS dependencies use `require()`, `__dirname` and `__filename`
// inside an ESM bundle (e.g. @argent/native-devtools-ios resolves bin/ off
// `__dirname`). The shimmed values point at the bundle's own location.
const ESM_REQUIRE_BANNER = {
  js:
    "import { createRequire as __createRequire } from 'node:module'; " +
    "import { fileURLToPath as __fileURLToPath } from 'node:url'; " +
    "import { dirname as __pathDirname } from 'node:path'; " +
    "const require = __createRequire(import.meta.url); " +
    "const __filename = __fileURLToPath(import.meta.url); " +
    "const __dirname = __pathDirname(__filename);",
};

// Source layout mirrors what `scripts/download-simulator-server.sh` writes:
// platform-keyed subdirectories of bin/.
const BIN_SRC_ROOT = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-ios/bin");
const AX_BIN_SRC = path.resolve(BIN_SRC_ROOT, "darwin/ax-service");
// Platform-NEUTRAL bin/tcp/ (not bin/darwin/tcp/): this binary is uploaded to the
// remote macOS orchestrator, so it must resolve from any host platform. Matches
// tcpBinDir() in native-devtools-ios/src/index.ts.
const AX_TCP_BIN_SRC = path.resolve(BIN_SRC_ROOT, "tcp/ax-service");
const BIN_DIR = path.resolve(__dirname, "../bin");
const AX_BIN_DEST = path.resolve(BIN_DIR, "darwin/ax-service");
const AX_TCP_BIN_DEST = path.resolve(BIN_DIR, "tcp/ax-service");
// tvOS control binaries. Both macOS-only, unix-socket only.
const TVOS_AX_BIN_SRC = path.resolve(BIN_SRC_ROOT, "darwin/tvos-ax-service");
const TVOS_HID_BIN_SRC = path.resolve(BIN_SRC_ROOT, "darwin/tvos-hid-daemon");
const TVOS_AX_BIN_DEST = path.resolve(BIN_DIR, "darwin/tvos-ax-service");
const TVOS_HID_BIN_DEST = path.resolve(BIN_DIR, "darwin/tvos-hid-daemon");
// Host platform keys (see hostPlatformKey() in @argent/native-devtools-ios):
// darwin is a universal binary; Linux ships one single-arch ELF per key;
// win32 ships a PE `.exe`.
const SUPPORTED_HOST_PLATFORMS = ["darwin", "linux", "linux-arm64", "win32"];
const simulatorServerFileName = (platform) =>
  platform === "win32" ? "simulator-server.exe" : "simulator-server";
const BUNDLED_META_DEST = path.resolve(
  WORKSPACE_ROOT,
  "packages/native-devtools-android/src/bundled-meta.ts"
);
const PERFETTO_VERSION_FILE = path.resolve(
  WORKSPACE_ROOT,
  "packages/argent-private/packages/native-devtools-android/PERFETTO_VERSION"
);
const DYLIBS_SRC = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-ios/dylibs");
const DYLIBS_DEST = path.resolve(__dirname, "../dylibs");
const SKILLS_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/skills");
const SKILLS_DEST = path.resolve(__dirname, "../skills");
const RULES_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/rules");
const RULES_DEST = path.resolve(__dirname, "../rules");
const AGENTS_SRC = path.resolve(WORKSPACE_ROOT, "packages/skills/agents");
const AGENTS_DEST = path.resolve(__dirname, "../agents");
const QUERIES_SRC = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-android/assets/queries");
const QUERIES_DEST = path.resolve(__dirname, "../assets/queries");
const TRACE_PROCESSOR_SRC = path.resolve(
  WORKSPACE_ROOT,
  "packages/native-devtools-android/assets/trace-processor"
);
const TRACE_PROCESSOR_DEST = path.resolve(__dirname, "../assets/trace-processor");
const ANDROID_PKG_DIR = path.resolve(WORKSPACE_ROOT, "packages/native-devtools-android");
const ANDROID_MANIFEST_SRC = path.join(ANDROID_PKG_DIR, "assets/manifest.json");
const ANDROID_MANIFEST_DEST = path.resolve(__dirname, "../assets/manifest.json");
const ANDROID_APK_SRC_DIR = path.join(ANDROID_PKG_DIR, "bin");
const UI_SRC = path.resolve(WORKSPACE_ROOT, "packages/ui/index.html");
const UI_DEST = path.resolve(__dirname, "../dist/preview-ui/index.html");
const UI_THEME_SRC = path.resolve(WORKSPACE_ROOT, "packages/ui/theme.css");
const UI_THEME_DEST = path.resolve(__dirname, "../dist/preview-ui/theme.css");
const TRACE_TEMPLATE_SRC = path.resolve(
  WORKSPACE_ROOT,
  "packages/tool-server/src/utils/ios-profiler/Argent.tracetemplate"
);
const TRACE_TEMPLATE_DEST = path.resolve(__dirname, "../assets/Argent.tracetemplate");
const TRACECFG_SRC = path.resolve(
  WORKSPACE_ROOT,
  "packages/native-devtools-android/assets/argent.tracecfg.pbtxt"
);
const TRACECFG_DEST = path.resolve(__dirname, "../assets/argent.tracecfg.pbtxt");

// Declarative copy plan for copyAsset() below.
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
  // iOS ax-service binary (macOS-only — runs inside an iOS Simulator).
  {
    kind: "file",
    src: AX_BIN_SRC,
    dest: AX_BIN_DEST,
    mode: 0o755,
    required: false,
    copiedLabel: "ax-service binary",
    missLabel: "ax-service binary",
  },
  // iOS ax-service TCP variant; only present when the TCP transport was built.
  {
    kind: "file",
    src: AX_TCP_BIN_SRC,
    dest: AX_TCP_BIN_DEST,
    mode: 0o755,
    required: false,
    copiedLabel: "ax-service (tcp) binary",
    missLabel: "ax-service (tcp) binary",
  },
  // tvOS AX reader — `simctl spawn`d inside an appletvsimulator to read the
  // focus-engine accessibility tree.
  {
    kind: "file",
    src: TVOS_AX_BIN_SRC,
    dest: TVOS_AX_BIN_DEST,
    mode: 0o755,
    required: false,
    copiedLabel: "tvos-ax-service binary",
    missLabel: "tvos-ax-service binary",
  },
  // tvOS HID daemon — runs on the macOS host, injects Siri-remote HID events
  // into the simulator via SimulatorKit.
  {
    kind: "file",
    src: TVOS_HID_BIN_SRC,
    dest: TVOS_HID_BIN_DEST,
    mode: 0o755,
    required: false,
    copiedLabel: "tvos-hid-daemon binary",
    missLabel: "tvos-hid-daemon binary",
  },
  // Android host-side Perfetto trace processor: the third-party WASM engine
  // (trace_processor.wasm + emscripten glue + engine.mjs decoder + LICENSE).
  // wasm-trace-processor.ts resolves them at `<pkg>/assets/trace-processor/`,
  // i.e. this exact destination. Not committed; fetched + sha256-verified by
  // scripts/download-trace-processor.sh.
  {
    kind: "dir",
    src: TRACE_PROCESSOR_SRC,
    dest: TRACE_PROCESSOR_DEST,
    required: true,
    copiedLabel: "trace-processor WASM asset(s)",
    missLabel: "trace-processor WASM assets directory",
    hint: "Run: bash scripts/download-trace-processor.sh (fetches from argent-private-releases)",
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
  // Android helper manifest.json: helperManifest()/bundledHelperApkPath() read it
  // at runtime, and the version-stamped APK filename comes from its versionName
  // (see the APK block after the copy loop).
  {
    kind: "file",
    src: ANDROID_MANIFEST_SRC,
    dest: ANDROID_MANIFEST_DEST,
    required: true,
    copiedLabel: "Android manifest",
    missLabel: "Android manifest",
    hint: "Run: bash scripts/download-native-binaries.sh (fetches from argent-private-releases)",
  },
  // Preview UI (@argent/ui) next to the bundled tool-server, where the /preview/
  // endpoint finds it via __dirname. The externalised theme.css must ship with
  // index.html — a partial copy 404s /preview/theme.css and serves an unstyled UI.
  {
    kind: "file",
    src: UI_SRC,
    dest: UI_DEST,
    required: false,
    copiedLabel: "preview UI",
    missLabel: "Preview UI",
  },
  {
    kind: "file",
    src: UI_THEME_SRC,
    dest: UI_THEME_DEST,
    required: false,
    copiedLabel: "preview UI theme.css",
    missLabel: "Preview UI theme.css",
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
  // Android profiler capture reads this via @argent/native-devtools-android's
  // `traceConfigPath()`, which resolves `<pkg>/assets/argent.tracecfg.pbtxt` —
  // i.e. this exact destination.
  {
    kind: "file",
    src: TRACECFG_SRC,
    dest: TRACECFG_DEST,
    required: true,
    copiedLabel: "argent.tracecfg.pbtxt",
    missLabel: "argent.tracecfg.pbtxt",
    hint: "This file is required for Android native profiling.",
  },
  // Android profiler SQL queries. traceProcessorQueriesDir() resolves
  // `<pkg>/assets/queries/`, i.e. this exact destination.
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
  // Skills shipped on npm; the full directory structure is mirrored.
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
 * @param {{ entry: string, out: string, format: "cjs" | "esm", label: string, external?: string[] }} opts
 */
function buildBundle({ entry, out, format, label, external = [] }) {
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node22",
    format,
    outfile: out,
    alias: ALIASES,
    mainFields: MAIN_FIELDS,
    define: TELEMETRY_DEFINE,
    // ESM bundles need the require() shim and must keep node: builtins external;
    // CJS bundles externalise only what the caller passes.
    ...(format === "esm"
      ? { banner: ESM_REQUIRE_BANNER, external: [...new Set(["node:*", ...external])] }
      : external.length > 0
        ? { external }
        : {}),
  });
  console.log(`✓ Bundled ${label} → ${path.relative(process.cwd(), out)}`);
}

/**
 * Count shown in the success line, or null when the asset isn't counted.
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

/**
 * Pinned Perfetto version from argent-private's PERFETTO_VERSION, falling back to
 * the committed constant in bundled-meta.ts when the submodule isn't checked out.
 */
function readPerfettoVersion() {
  try {
    const v = fs.readFileSync(PERFETTO_VERSION_FILE, "utf8").trim();
    if (v) return v;
  } catch {
    /* submodule absent — fall through to committed constant */
  }
  try {
    const existing = fs.readFileSync(BUNDLED_META_DEST, "utf8");
    const m = existing.match(/PERFETTO_VERSION\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    /* committed file missing — final fallback below */
  }
  return "v55.3";
}

/**
 * Regenerate bundled-meta.ts so it pins the Perfetto version stamping the
 * bundled trace_processor.wasm.
 */
function generateBundledMeta() {
  const version = readPerfettoVersion();
  const content = `// GENERATED by packages/argent/scripts/bundle-tools.cjs, which overwrites this
// file from argent-private's PERFETTO_VERSION; the committed value is a fallback
// so builds without that submodule still compile. Informational only — it stamps
// the bundled \`trace_processor.wasm\`, nothing resolves against it.

export const PERFETTO_VERSION = "${version}";
`;
  fs.writeFileSync(BUNDLED_META_DEST, content);
  console.log(`✓ Generated bundled-meta.ts (perfetto=${version})`);
}

// Must run before esbuild, so PERFETTO_VERSION is inlined into the bundles.
generateBundledMeta();

// Purge artifact directories so stale files don't survive across builds. Derived
// from the table so it can't drift.
const PURGE_DIRS = [BIN_DIR, ...ASSETS.filter((a) => a.kind === "dir").map((a) => a.dest)];
for (const dir of PURGE_DIRS) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// The `argent-simulator-server` dispatcher npm's `bin` field publishes; it picks
// the right per-platform binary at invocation time. Source lives in scripts/ so
// it isn't entangled with the gitignored bundle output under bin/.
const DISPATCHER_SRC = path.resolve(__dirname, "argent-simulator-server.cjs");
const DISPATCHER_DEST = path.resolve(BIN_DIR, "argent-simulator-server.cjs");
fs.copyFileSync(DISPATCHER_SRC, DISPATCHER_DEST);
fs.chmodSync(DISPATCHER_DEST, 0o755);

// The Android manifest is a single file under assets/, outside PURGE_DIRS, so
// remove it explicitly: a stale manifest would fool helperManifest() into
// pointing at an APK that's no longer present.
fs.rmSync(ANDROID_MANIFEST_DEST, { force: true });

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

// tree-sitter / tree-sitter-typescript are native addons (.node) esbuild cannot
// inline; external so the bundle `require()`s them at runtime from the published
// package's own dependencies.
//
// `electron` MUST stay external. Inlined, electron's binary-path lookup runs
// with __dirname = <install>/dist (no path.txt there) and throws "Electron
// failed to install correctly" at eval time. External keeps the runtime
// `require("electron")` in preview-window.ts resolving against the installed
// node_modules/electron with an intact __dirname.
//
// `@fails-components/webtransport` and its http3-quiche transport ship native
// addons (quiche, prebuilt .node binaries) that can't be inlined either; they
// are declared on @swmansion/argent, so external resolves them from
// node_modules/ at runtime.
//
// `dtrace-provider` MUST stay external. It is an OPTIONAL dependency of bunyan
// (the tool-server event-log logger), which hides it from bundlers with
// `require('dtrace-provider' + '')` in a try/catch — a failed require just
// disables the unused DTrace USDT probes. esbuild constant-folds that string
// back to a literal and then chokes on dtrace-provider's own dynamic native
// binding require. External restores bunyan's intent: the published package
// never declares it, so the require misses and bunyan nulls it out.
buildBundle({
  entry: TOOLS_ENTRY,
  out: OUT_FILE,
  format: "cjs",
  label: "tools server",
  external: [
    "tree-sitter",
    "tree-sitter-typescript",
    "electron",
    "@fails-components/webtransport",
    "@fails-components/webtransport-transport-http3-quiche",
    "dtrace-provider",
  ],
});

// The remaining bundles are ESM so that:
//   - installer: import.meta.dirname works at runtime (the dispatcher
//     lazy-imports it, so its workspace dep needn't resolve in the published pkg);
//   - MCP server: the @modelcontextprotocol/sdk ESM export paths resolve.
const ESM_BUNDLES = [
  { entry: INSTALLER_ENTRY, out: INSTALLER_OUT_FILE, label: "installer" },
  { entry: MCP_ENTRY, out: MCP_OUT_FILE, label: "MCP server" },
  // node-pty is a native addon `argent lens` loads at runtime (the agent PTY
  // proxy); esbuild can't inline a .node. Absent install → loadNodePty() returns
  // null → lens falls back to a new terminal window.
  { entry: CLI_ENTRY, out: CLI_OUT_FILE, label: "CLI commands", external: ["node-pty"] },
];
for (const b of ESM_BUNDLES) {
  buildBundle({ ...b, format: "esm" });
}

for (const a of ASSETS) {
  copyAsset(a);
}

// `electron` stays external here too — tool-server's preview-window.ts resolves
// the executable via `require("electron")`. The bundled main.cjs lands next to
// the tool-server bundle so that same helper finds it at
// `path.join(__dirname, "preview-window", "main.cjs")`, without needing
// @argent/preview-window to be a published sibling pkg.
fs.mkdirSync(path.dirname(PREVIEW_WINDOW_OUT_FILE), { recursive: true });
buildBundle({
  entry: PREVIEW_WINDOW_ENTRY,
  out: PREVIEW_WINDOW_OUT_FILE,
  format: "cjs",
  label: "preview-window main",
  external: ["electron", "node:*"],
});

// Require the darwin binary only when bundling ON darwin (the publish pipeline):
// a Linux contributor running `npm run pack` can't produce the macOS binary, so
// don't block them on its absence.
for (const platform of SUPPORTED_HOST_PLATFORMS) {
  const binaryFile = simulatorServerFileName(platform);
  const src = path.join(BIN_SRC_ROOT, platform, binaryFile);
  const destDir = path.join(BIN_DIR, platform);
  const dest = path.join(destDir, binaryFile);
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

// Screen-sharing agent resources (host-independent jar + per-ABI .so the
// `android_device` controller pushes to a connected phone over adb): one shared
// copy at the bin root; simulatorServerRunDir() points the spawn cwd here.
// Optional: physical-device support degrades without them.
const RESOURCES_SRC = path.join(BIN_SRC_ROOT, "resources");
if (fs.existsSync(RESOURCES_SRC)) {
  fs.cpSync(RESOURCES_SRC, path.join(BIN_DIR, "resources"), { recursive: true });
  console.log(
    `✓ Copied screen-sharing agent resources → ${path.relative(process.cwd(), BIN_DIR)}/resources`
  );
} else {
  console.warn(`⚠ screen-sharing agent resources not found at ${RESOURCES_SRC} — skipping`);
}

// The Android helper APK is the only Android native artifact left (the trace
// processor ships as WASM under assets/trace-processor/). Its filename is
// version-stamped from manifest.json's versionName (see bundledHelperApkPath());
// it is required at runtime, so a missing one throws.
const manifest = JSON.parse(fs.readFileSync(ANDROID_MANIFEST_SRC, "utf8"));
const apkName = `argent-android-devtools-${manifest.versionName}.apk`;
const apkSrc = path.join(ANDROID_APK_SRC_DIR, apkName);
if (fs.existsSync(apkSrc)) {
  fs.copyFileSync(apkSrc, path.join(BIN_DIR, apkName));
  console.log(`✓ Copied Android helper APK → ${path.relative(process.cwd(), BIN_DIR)}/${apkName}`);
} else {
  throw new Error(
    `Android helper APK not found at ${apkSrc}.\n` +
      `Run: bash scripts/download-native-binaries.sh (fetches from argent-private-releases)\n` +
      `or: bash packages/native-devtools-android/scripts/build.sh`
  );
}
