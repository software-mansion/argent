import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";

const STATE_DIR = path.join(homedir(), ".argent");
const STATE_FILE = path.join(STATE_DIR, "tool-server.json");
const LOG_FILE = path.join(STATE_DIR, "tool-server.log");

/**
 * Filesystem locations the launcher needs to spawn tool-server. Provided by
 * the consuming package (typically the published `@swmansion/argent`), since
 * only that layer knows where its bundled artifacts live.
 */
export interface ToolsServerPaths {
  /** Path to the bundled tool-server.cjs */
  bundlePath: string;
  /** Directory containing the simulator-server binary */
  simulatorServerDir: string;
  /** Directory containing the native devtools dylibs */
  nativeDevtoolsDir: string;
}

export function buildToolsServerEnv(
  paths: ToolsServerPaths,
  port: number,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    PORT: String(port),
    ARGENT_SIMULATOR_SERVER_DIR: paths.simulatorServerDir,
    ARGENT_NATIVE_DEVTOOLS_DIR: paths.nativeDevtoolsDir,
  };
}

interface ToolsServerState {
  port: number;
  pid: number;
  startedAt: string;
  bundlePath: string;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr !== "object") {
        srv.close(() => reject(new Error("Could not bind to find free port")));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tools`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function spawnToolsServer(
  paths: ToolsServerPaths,
  port: number
): Promise<{ port: number; pid: number }> {
  return new Promise((resolve, reject) => {
    let logFd: number;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      logFd = fs.openSync(LOG_FILE, "a");
    } catch {
      logFd = fs.openSync("/dev/null", "w");
    }

    const child = spawn("node", [paths.bundlePath, "start"], {
      detached: true,
      stdio: ["ignore", "pipe", logFd],
      env: buildToolsServerEnv(paths, port),
    });

    child.unref();

    const pid = child.pid;
    if (!pid) {
      reject(new Error("Failed to get PID of spawned tools server"));
      return;
    }

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const rl = readline.createInterface({ input: child.stdout! });

    rl.on("line", (line) => {
      // Match: "Tools server listening on http://127.0.0.1:<port>"
      const match = line.match(/Tools server listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        const actualPort = parseInt(match[1]!, 10);
        rl.close();
        // Resume stdout so the pipe stays open and the child's console.log calls
        // don't fail with EPIPE once the readline interface stops consuming it.
        child.stdout?.resume();
        settle(() => resolve({ port: actualPort, pid }));
      }
    });

    child.on("error", (err) => {
      rl.close();
      settle(() => reject(err));
    });

    child.on("exit", (code) => {
      rl.close();
      settle(() => reject(new Error(`tool-server exited with code ${code} before becoming ready`)));
    });

    const timer = setTimeout(() => {
      rl.close();
      settle(() => reject(new Error("Timed out waiting for tools server to become ready")));
    }, 15_000);

    rl.on("close", () => clearTimeout(timer));
  });
}

async function readState(): Promise<ToolsServerState | null> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return JSON.parse(raw) as ToolsServerState;
  } catch {
    return null;
  }
}

async function writeState(state: ToolsServerState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function clearState(): Promise<void> {
  try {
    await unlink(STATE_FILE);
  } catch {
    // already gone
  }
}

export async function killToolServer(): Promise<void> {
  const state = await readState();
  if (!state) return;
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // already gone
  }
  await clearState();
}

export async function ensureToolsServer(paths: ToolsServerPaths): Promise<string> {
  const state = await readState();

  if (state) {
    const alive = isProcessAlive(state.pid);
    if (alive) {
      const healthy = await isHealthy(state.port);
      if (healthy) {
        return `http://127.0.0.1:${state.port}`;
      }
    }
    await clearState();
  }

  // Spawn a new server
  const port = await findFreePort();
  const { port: actualPort, pid } = await spawnToolsServer(paths, port);

  await writeState({
    port: actualPort,
    pid,
    startedAt: new Date().toISOString(),
    bundlePath: paths.bundlePath,
  });

  return `http://127.0.0.1:${actualPort}`;
}

export const STATE_PATHS = { STATE_DIR, STATE_FILE, LOG_FILE };
