#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Full dev mode — no packing, no global install needed.
 *
 * What it does:
 *   1. Builds native devtools dylibs (libInjectionBootstrap, libNativeDevtoolsIos, libKeyboardPatch)
 *   2. Builds MCP TypeScript (tsc only, no esbuild tool-server bundle)
 *   3. Sets up packages/mcp/bin/ and packages/mcp/dist/ for local use
 *   4. Patches supported editor MCP configs to point argent at the local dist
 *   5. Starts the tool-server from source via ts-node (no build needed)
 *   6. Writes ~/.argent/tool-server.json so the local MCP picks it up
 *   7. On exit: restores patched editor configs and stops the tool-server
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
const MCP_PKG = path.join(ROOT, "packages", "mcp");
const TOOL_SERVER_PKG = path.join(ROOT, "packages", "tool-server");
const NATIVE_DEVTOOLS_PKG = path.join(ROOT, "packages", "native-devtools-ios");
const STATE_DIR = path.join(os.homedir(), ".argent");
const STATE_FILE = path.join(STATE_DIR, "tool-server.json");
const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
const CURSOR_DIR = path.join(os.homedir(), ".cursor");
const CURSOR_MCP_JSON = path.join(CURSOR_DIR, "mcp.json");
const PORT = parseInt(process.env.PORT ?? "3001", 10);

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ── Step 1: Build native devtools dylibs ─────────────────────────────────────

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

// Try to init the submodule and rebuild. Failure is non-fatal if pre-built
// dylibs are already present — developers without argent-private access can
// still work on Argent using the committed binaries.
let submoduleReady = false;
try {
  // Preserve an existing argent-private checkout so local branch switches
  // are not reset back to the superproject's recorded gitlink on every dev run.
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
    console.error("  Grant SSH access to github.com/software-mansion-labs/argent-private");
    console.error(
      "  or obtain pre-built dylibs and place them in packages/native-devtools-ios/dylibs/"
    );
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

// ── Step 2: Build MCP TypeScript ─────────────────────────────────────────────

console.log("Building MCP TypeScript...");
execSync("npm run build:mcp -w @swmansion/argent", {
  cwd: ROOT,
  stdio: "inherit",
});
console.log("✓ MCP TypeScript built\n");

// ── Step 3: Set up packages/mcp/bin/ and skills/rules/agents ─────────────────

const BIN_DIR = path.join(MCP_PKG, "bin");
const BIN_SRC = path.join(NATIVE_DEVTOOLS_PKG, "bin", "simulator-server");
const BIN_DEST = path.join(BIN_DIR, "simulator-server");
fs.mkdirSync(BIN_DIR, { recursive: true });
if (fs.existsSync(BIN_SRC)) {
  fs.copyFileSync(BIN_SRC, BIN_DEST);
  fs.chmodSync(BIN_DEST, 0o755);
  console.log("✓ Copied simulator-server binary");
} else {
  console.warn("⚠ simulator-server binary not found — gestures won't work");
}

for (const [srcName, destName] of [
  ["skills/skills", "skills"],
  ["skills/rules", "rules"],
  ["skills/agents", "agents"],
]) {
  const src = path.join(ROOT, "packages", srcName);
  const dest = path.join(MCP_PKG, destName);
  if (fs.existsSync(src)) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
}
console.log("✓ Copied skills/rules/agents");

// Stub tool-server.cjs — the launcher won't use it as long as the dev server
// is registered in the state file, but it needs to exist to avoid a crash.
const STUB = path.join(MCP_PKG, "dist", "tool-server.cjs");
if (!fs.existsSync(STUB)) {
  fs.mkdirSync(path.dirname(STUB), { recursive: true });
  fs.writeFileSync(
    STUB,
    "throw new Error('dev mode: tool-server stub — start npm run dev first');\n"
  );
}

function restoreMcpEntry(configPath, originalEntry, existedBefore) {
  const config = readJson(configPath);
  if (!config.mcpServers) config.mcpServers = {};

  if (originalEntry) {
    config.mcpServers.argent = originalEntry;
  } else {
    delete config.mcpServers.argent;
  }

  if (config.mcpServers && Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }

  if (!existedBefore && Object.keys(config).length === 0) {
    try {
      fs.unlinkSync(configPath);
    } catch {}
    return;
  }

  writeJson(configPath, config);
}

// ── Step 4: Patch editor MCP configs to use local MCP dist ───────────────────

const LOCAL_MCP_ENTRY = path.join(MCP_PKG, "dist", "cli.js");
const LOG_FILE = path.join(STATE_DIR, "mcp-calls.log");

const claudeConfigExists = fs.existsSync(CLAUDE_JSON);
const claudeConfig = readJson(CLAUDE_JSON);
const originalArgentEntry = claudeConfig?.mcpServers?.argent ?? null;
const shouldPatchCursor = fs.existsSync(CURSOR_DIR);
const cursorConfigExists = fs.existsSync(CURSOR_MCP_JSON);
const cursorConfig = shouldPatchCursor ? readJson(CURSOR_MCP_JSON) : {};
const originalCursorArgentEntry = cursorConfig?.mcpServers?.argent ?? null;

const devMcpEntry = {
  type: "stdio",
  command: "node",
  args: [LOCAL_MCP_ENTRY, "mcp"],
  env: { ARGENT_MCP_LOG: LOG_FILE },
};

if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};
claudeConfig.mcpServers.argent = devMcpEntry;
writeJson(CLAUDE_JSON, claudeConfig);
console.log(`✓ Patched ~/.claude.json → node ${LOCAL_MCP_ENTRY} mcp`);

if (shouldPatchCursor) {
  if (!cursorConfig.mcpServers) cursorConfig.mcpServers = {};
  cursorConfig.mcpServers.argent = {
    command: "node",
    args: [LOCAL_MCP_ENTRY, "mcp"],
    env: { ARGENT_MCP_LOG: LOG_FILE },
  };
  writeJson(CURSOR_MCP_JSON, cursorConfig);
  console.log(`✓ Patched ~/.cursor/mcp.json → node ${LOCAL_MCP_ENTRY} mcp\n`);
} else {
  console.log("• Skipped Cursor patch (no ~/.cursor directory found)\n");
}

// ── Cleanup on exit ───────────────────────────────────────────────────────────

let toolServerPid = null;

function cleanup() {
  console.log("\nCleaning up...");

  // Stop tool-server
  if (toolServerPid && isProcessAlive(toolServerPid)) {
    process.kill(toolServerPid, "SIGTERM");
  }
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {}

  // Restore editor configs
  restoreMcpEntry(CLAUDE_JSON, originalArgentEntry, claudeConfigExists);
  console.log("✓ Restored ~/.claude.json");
  if (shouldPatchCursor) {
    restoreMcpEntry(CURSOR_MCP_JSON, originalCursorArgentEntry, cursorConfigExists);
    console.log("✓ Restored ~/.cursor/mcp.json");
  }
  console.log("Done.");
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("exit", cleanup);

async function main() {
  // ── Step 5: Kill any existing registered tool-server ───────────────────────

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const existingState = readJson(STATE_FILE);
  if (existingState.pid && isProcessAlive(existingState.pid)) {
    console.log(`Stopping existing tool-server (PID ${existingState.pid})...`);
    process.kill(existingState.pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 600));
  }
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {}

  // ── Step 6: Start tool-server from source ──────────────────────────────────

  console.log(`Starting dev tool-server on port ${PORT}...`);

  const toolServer = spawn("npx", ["ts-node", "src/index.ts"], {
    cwd: TOOL_SERVER_PKG,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT) },
  });

  toolServerPid = toolServer.pid;

  const logStream = fs.createWriteStream(path.join(STATE_DIR, "tool-server.log"), { flags: "a" });
  toolServer.stdout.pipe(logStream);
  toolServer.stderr.pipe(logStream);

  toolServer.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\nTool-server exited with code ${code}. Check ~/.argent/tool-server.log`);
    }
  });

  // ── Step 7: Wait for tool-server to be ready ───────────────────────────────

  process.stdout.write("Waiting for tool-server");
  const ready = await waitForHttp(`http://127.0.0.1:${PORT}/tools`);
  if (!ready) {
    console.error("\nTool-server failed to start. Check ~/.argent/tool-server.log");
    cleanup();
    process.exit(1);
  }
  console.log(" ready.");

  // ── Step 8: Write state file ────────────────────────────────────────────────

  writeJson(STATE_FILE, {
    port: PORT,
    pid: toolServerPid,
    startedAt: new Date().toISOString(),
    bundlePath: "dev",
  });

  // ── Done ────────────────────────────────────────────────────────────────────

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

  // Keep alive until tool-server exits or Ctrl+C
  await new Promise((resolve) => {
    toolServer.on("exit", resolve);
  });
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
