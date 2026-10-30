#!/usr/bin/env node
"use strict";

/**
 * Full dev mode — runs argent from this checkout: no packing, no global install.
 *
 * Usage:
 *   npm run dev
 *   PORT=4000 npm run dev
 */

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const ARGENT_PKG = path.join(ROOT, "packages", "argent");
const TOOL_SERVER_PKG = path.join(ROOT, "packages", "tool-server");
const NATIVE_DEVTOOLS_PKG = path.join(ROOT, "packages", "native-devtools-ios");
const STATE_DIR = path.join(os.homedir(), ".argent");
const STATE_FILE = path.join(STATE_DIR, "tool-server.json");
const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
const CURSOR_DIR = path.join(os.homedir(), ".cursor");
const CURSOR_MCP_JSON = path.join(CURSOR_DIR, "mcp.json");
const PORT = parseInt(process.env.PORT ?? "3001", 10);

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// Dylibs need Xcode to build and DYLD_INSERT_LIBRARIES into the iOS Simulator
// to run, so non-macOS hosts skip this and still get a usable dev setup.
if (process.platform === "darwin") {
  const DYLIBS_DIR = path.join(NATIVE_DEVTOOLS_PKG, "dylibs");
  const DYLIBS_EXIST = fs.existsSync(path.join(DYLIBS_DIR, "libNativeDevtoolsIos.dylib"));
  const PRIVATE_NATIVE_DEVTOOLS_SRC = path.join(
    ROOT,
    "packages",
    "argent-private",
    "packages",
    "native-devtools-ios",
    "Sources",
    "NativeDevtoolsIos"
  );

  // Non-fatal when pre-built dylibs are already present, so contributors
  // without argent-private access can still run dev.
  let submoduleReady = false;
  try {
    // Preserve an existing argent-private checkout so a local branch switch is
    // not reset to the superproject's recorded gitlink on every dev run.
    if (!fs.existsSync(PRIVATE_NATIVE_DEVTOOLS_SRC)) {
      execSync("git submodule update --init packages/argent-private", {
        cwd: ROOT,
        stdio: "pipe",
      });
    }
    submoduleReady = true;
  } catch {
    if (DYLIBS_EXIST) {
      console.warn("⚠ argent-private submodule unavailable — using pre-built dylibs\n");
    } else {
      console.error("✗ argent-private submodule unavailable and no pre-built dylibs found.");
      console.error("  Get SSH access to github.com/software-mansion/argent-private,");
      console.error("  or download the pre-built dylibs: npm run download:native-binaries");
      process.exit(1);
    }
  }

  if (submoduleReady) {
    console.log("Building native devtools dylibs...");
    execSync("bash scripts/build.sh dev", {
      cwd: NATIVE_DEVTOOLS_PKG,
      stdio: "inherit",
    });
    console.log("✓ Native devtools dylibs built\n");
  }
} else {
  console.log(`⊘ Skipping native devtools dylibs build (macOS-only on ${process.platform})\n`);
}

console.log("Building dispatcher TypeScript...");
execSync("npm run build:dispatcher -w @swmansion/argent", {
  cwd: ROOT,
  stdio: "inherit",
});
console.log("✓ Dispatcher TypeScript built\n");

console.log("Bundling dispatcher subcommands...");
execSync("node scripts/bundle-tools.cjs --esm-only", {
  cwd: ARGENT_PKG,
  stdio: "inherit",
});
console.log("✓ Dispatcher subcommands bundled\n");

// Only the current host's key, unlike bundle-tools.cjs which copies every
// supported host's binary. Mirrors hostPlatformKey() in
// @argent/native-devtools-ios.
const HOST_PLATFORM_KEY =
  process.platform === "linux" && process.arch === "arm64" ? "linux-arm64" : process.platform;
const BIN_DIR = path.join(ARGENT_PKG, "bin", HOST_PLATFORM_KEY);
// Mirrors simulatorServerBinaryName() in @argent/native-devtools-ios.
const BIN_BASENAME = process.platform === "win32" ? "simulator-server.exe" : "simulator-server";
const BIN_SRC = path.join(NATIVE_DEVTOOLS_PKG, "bin", HOST_PLATFORM_KEY, BIN_BASENAME);
const BIN_DEST = path.join(BIN_DIR, BIN_BASENAME);
fs.mkdirSync(BIN_DIR, { recursive: true });
if (fs.existsSync(BIN_SRC)) {
  fs.copyFileSync(BIN_SRC, BIN_DEST);
  fs.chmodSync(BIN_DEST, 0o755);
  console.log(`✓ Copied simulator-server binary (${HOST_PLATFORM_KEY})`);
} else {
  console.warn(
    `⚠ simulator-server binary not found at ${BIN_SRC} — gestures won't work. ` +
      `Run: bash scripts/download-simulator-server.sh`
  );
}

for (const [srcName, destName] of [
  ["skills/skills", "skills"],
  ["skills/rules", "rules"],
  ["skills/agents", "agents"],
]) {
  const src = path.join(ROOT, "packages", srcName);
  const dest = path.join(ARGENT_PKG, destName);
  if (fs.existsSync(src)) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
}
console.log("✓ Copied skills/rules/agents");

// Dev never builds the esbuild bundle, and the launcher errors out when this
// path is missing.
const STUB = path.join(ARGENT_PKG, "dist", "tool-server.cjs");
if (!fs.existsSync(STUB)) {
  fs.mkdirSync(path.dirname(STUB), { recursive: true });
  fs.writeFileSync(
    STUB,
    "throw new Error('dev mode: tool-server stub — start npm run dev first');\n"
  );
}

const LOCAL_MCP_ENTRY = path.join(ARGENT_PKG, "dist", "cli.js");
const LOG_FILE = path.join(STATE_DIR, "mcp-calls.log");

const devMcpEntry = {
  type: "stdio",
  command: "node",
  args: [LOCAL_MCP_ENTRY, "mcp"],
  // Route the dev MCP at the running dev tool-server; without it the MCP
  // auto-spawns dist/tool-server.cjs, which in dev is the throwing stub. The
  // dev server runs auth-disabled, so no ARGENT_AUTH_TOKEN.
  env: { ARGENT_MCP_LOG: LOG_FILE, ARGENT_TOOLS_URL: `http://127.0.0.1:${PORT}` },
};

/**
 * @typedef {object} McpTarget
 * @property {string} label
 * @property {string} configPath
 * @property {object} devEntry
 * @property {boolean} [patched]
 * @property {boolean} [existedBefore]
 * @property {object | null} [originalEntry]
 */
/** @type {McpTarget[]} */
const mcpTargets = [{ label: "~/.claude.json", configPath: CLAUDE_JSON, devEntry: devMcpEntry }];
if (fs.existsSync(CURSOR_DIR)) {
  mcpTargets.push({
    label: "~/.cursor/mcp.json",
    configPath: CURSOR_MCP_JSON,
    devEntry: { command: "node", args: [LOCAL_MCP_ENTRY, "mcp"], env: devMcpEntry.env },
  });
}

function patchMcpEntry(target) {
  target.existedBefore = fs.existsSync(target.configPath);
  const config = readJson(target.configPath);
  target.originalEntry = config.mcpServers?.argent ?? null;
  config.mcpServers = { ...config.mcpServers, argent: target.devEntry };
  writeJson(target.configPath, config);
  target.patched = true;
  console.log(`✓ Patched ${target.label} → node ${LOCAL_MCP_ENTRY} mcp`);
}

function holdsEntry(config, entry) {
  return JSON.stringify(config.mcpServers?.argent) === JSON.stringify(entry);
}

/**
 * Put the original entry back, unless something else (another dev run, an
 * `argent init`) rewrote it meanwhile. Returns whether it acted.
 */
function restoreMcpEntry(target) {
  if (!target.patched) return false;
  const config = readJson(target.configPath);
  if (!holdsEntry(config, target.devEntry)) return false;

  if (target.originalEntry) {
    config.mcpServers.argent = target.originalEntry;
  } else {
    delete config.mcpServers.argent;
  }

  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }

  if (!target.existedBefore && Object.keys(config).length === 0) {
    try {
      fs.unlinkSync(target.configPath);
    } catch {
      /* file already absent — nothing to remove */
    }
    return true;
  }

  writeJson(target.configPath, config);
  return true;
}

// An external device provider (Radon IDE) spawns `[node, cli.js, "providers",
// ...]`, resolving both paths from `~/.argent/cli.json`, written by `argent
// init`/`update`, which a repo checkout never runs. Its only fallback is
// `argent` on PATH, which dev mode does not provide, so without this the
// provider integration is the one thing left pointing away from the local
// build. Patched and restored like the editor configs above.
const CLI_RECORD = path.join(STATE_DIR, "cli.json");
let originalCliRecord = null;

const devCliRecord = {
  cli: LOCAL_MCP_ENTRY,
  /**
   * Neither "global" nor "local". This names a repo checkout. Nothing branches
   * on it (`argent uninstall` compares paths) so the value is inert.
   */
  mode: "dev",
  node: process.execPath,
  updatedAt: new Date().toISOString(),
  version: readJson(path.join(ARGENT_PKG, "package.json")).version ?? "0.0.0",
};

function patchEditorConfigs() {
  for (const target of mcpTargets) patchMcpEntry(target);
  if (mcpTargets.length === 1) {
    console.log("• Skipped Cursor patch (no ~/.cursor directory found)");
  }

  originalCliRecord = fs.existsSync(CLI_RECORD) ? fs.readFileSync(CLI_RECORD, "utf8") : null;
  writeJson(CLI_RECORD, devCliRecord);
  console.log(`✓ Patched ~/.argent/cli.json → node ${LOCAL_MCP_ENTRY} providers\n`);
}

/**
 * Put `~/.argent/cli.json` back, unless something else rewrote it meanwhile. An
 * `argent init` mid-session leaves a record for a real install and clobbering
 * that would point providers at a checkout we are shutting down. Returns
 * whether it acted.
 */
function restoreCliRecord() {
  try {
    const current = fs.existsSync(CLI_RECORD) ? fs.readFileSync(CLI_RECORD, "utf8") : null;
    if (current !== JSON.stringify(devCliRecord, null, 2) + "\n") return false;

    if (originalCliRecord === null) {
      fs.unlinkSync(CLI_RECORD);
    } else {
      fs.writeFileSync(CLI_RECORD, originalCliRecord);
    }

    return true;
  } catch {
    /** A stale record only costs the next run a re-patch */
    return false;
  }
}

let toolServerPid = null;

function cleanup() {
  console.log("\nCleaning up...");

  if (toolServerPid && isProcessAlive(toolServerPid)) {
    process.kill(toolServerPid, "SIGTERM");
  }
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* state file already absent — nothing to remove */
  }

  for (const target of mcpTargets) {
    if (restoreMcpEntry(target)) console.log(`✓ Restored ${target.label}`);
  }
  if (restoreCliRecord()) {
    console.log("✓ Restored ~/.argent/cli.json");
  }
  console.log("Done.");
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
}
process.on("exit", cleanup);

async function waitForExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Stop the previous dev run through its own dev.cjs, so it restores the editor
 * configs before this run reads them.
 */
async function stopPreviousRun() {
  const state = readJson(STATE_FILE);
  const pids = [state.devPid, state.pid].filter((pid) => pid && isProcessAlive(pid));
  if (pids.length === 0) return;

  console.log(`Stopping existing dev tool-server (PID ${pids[0]})...`);
  process.kill(pids[0], "SIGTERM");
  for (const pid of pids) await waitForExit(pid);
}

async function isPortAnswering(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

function toolServerEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, ARGENT_PORT: String(PORT), ARGENT_HOST: "127.0.0.1" };
  delete env.ARGENT_AUTH_TOKEN;
  return env;
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  await stopPreviousRun();
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* state file already absent — nothing to remove */
  }

  if (await isPortAnswering(PORT)) {
    console.error(
      `✗ Port ${PORT} is already in use (another tool-server, e.g. npm run start?).\n` +
        `  Stop it, or pick another port: PORT=4000 npm run dev`
    );
    process.exit(1);
  }

  patchEditorConfigs();

  console.log(`Starting dev tool-server on port ${PORT}...`);

  const tsNodeBin = require.resolve("ts-node/dist/bin.js", { paths: [TOOL_SERVER_PKG] });
  const toolServer = spawn(process.execPath, [tsNodeBin, "src/index.ts", "start"], {
    cwd: TOOL_SERVER_PKG,
    stdio: ["ignore", "pipe", "pipe"],
    env: toolServerEnv(),
  });

  toolServerPid = toolServer.pid;

  const logStream = fs.createWriteStream(path.join(STATE_DIR, "tool-server.log"), { flags: "a" });
  toolServer.stdout.pipe(logStream);
  toolServer.stderr.pipe(logStream);

  toolServer.on("exit", (code, signal) => {
    if (code === 0) return;
    console.error(
      `\nTool-server exited with ${signal ?? `code ${code}`}. Check ~/.argent/tool-server.log`
    );
    process.exitCode = 1;
  });

  process.stdout.write("Waiting for tool-server");
  const ready = await waitForHttp(`http://127.0.0.1:${PORT}/tools`);
  if (!ready) {
    console.error("\nTool-server failed to start. Check ~/.argent/tool-server.log");
    cleanup();
    process.exit(1);
  }
  console.log(" ready.");

  writeJson(STATE_FILE, {
    port: PORT,
    pid: toolServerPid,
    devPid: process.pid,
    startedAt: new Date().toISOString(),
    bundlePath: "dev",
  });

  console.log(`
✓ Dev environment ready
  Tool-server: http://127.0.0.1:${PORT}/tools
  MCP:         ${LOCAL_MCP_ENTRY}
  Logs:        ~/.argent/tool-server.log

  Start a new Claude Code or Cursor session to pick up the local MCP.

  After tool-server code changes → Ctrl+C and re-run npm run dev
  After MCP code changes         → re-run npm run dev (rebuilds MCP automatically)

Press Ctrl+C to stop and restore global argent.
`);

  await new Promise((resolve) => {
    toolServer.on("exit", resolve);
  });
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
