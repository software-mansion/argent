import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, rename, chmod } from "node:fs/promises";

const STATE_DIR = path.join(homedir(), ".argent");
const STATE_FILE = path.join(STATE_DIR, "tool-server.json");
const LOG_FILE = path.join(STATE_DIR, "tool-server.log");

const AUTH_TOKEN_BYTES = 32;
export const AUTH_TOKEN_ENV = "ARGENT_AUTH_TOKEN";

// Idle-shutdown policy for auto-spawned servers (MCP / `argent run` path). The
// CLI's `argent server start` overrides this; manual launches default to no
// timeout.
const AUTOSPAWN_IDLE_TIMEOUT_MINUTES = 30;

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

export interface BuildToolsServerEnvOptions {
  /** Bind host. Omit to inherit the tool-server default (127.0.0.1). */
  host?: string;
  /** Idle-timeout minutes (0 disables). Omit to inherit the tool-server default. */
  idleTimeoutMinutes?: number;
  /**
   * Per-process auth token. When set, exported as `ARGENT_AUTH_TOKEN` so the
   * tool-server enforces `Authorization: Bearer <token>`. Omit (or pass empty)
   * to run the server with authentication disabled — used by the manual
   * `argent server start` path, which prints its own no-auth warning.
   */
  token?: string;
}

export function buildToolsServerEnv(
  paths: ToolsServerPaths,
  port: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: BuildToolsServerEnvOptions = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ARGENT_PORT: String(port),
    ARGENT_SIMULATOR_SERVER_DIR: paths.simulatorServerDir,
    ARGENT_NATIVE_DEVTOOLS_DIR: paths.nativeDevtoolsDir,
  };
  if (options.host !== undefined) env.ARGENT_HOST = options.host;
  if (options.idleTimeoutMinutes !== undefined) {
    env.ARGENT_IDLE_TIMEOUT_MINUTES = String(options.idleTimeoutMinutes);
  }
  if (options.token) env[AUTH_TOKEN_ENV] = options.token;
  return env;
}

export interface ToolsServerState {
  port: number;
  pid: number;
  startedAt: string;
  bundlePath: string;
  /** Bind host. Optional for backward-compat with state files written by older versions. */
  host?: string;
  /**
   * Per-process random token. When present, required as
   * `Authorization: Bearer <token>` on every tool-server request. Persisted
   * with mode 0600 so other users on the host can't read it. Optional:
   * `argent server start` writes tokenless (auth-disabled) state.
   */
  token?: string;
}

/** Handle returned to clients: the base URL plus the matching auth token. */
export interface ToolsServerHandle {
  url: string;
  token: string;
}

function generateToken(): string {
  return randomBytes(AUTH_TOKEN_BYTES).toString("hex");
}

/**
 * Mint a fresh tool-server auth token. Exposed so `argent server start` can
 * issue one for a long-lived / remote server.
 */
export function generateAuthToken(): string {
  return generateToken();
}

export function findFreePort(): Promise<number> {
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

export function isToolsServerProcessAlive(pid: number): boolean {
  return isProcessAlive(pid);
}

/**
 * The wildcard hosts (`0.0.0.0`, `::`) accept connections on every interface
 * including loopback, but you cannot _connect_ to them — for the health check
 * we have to use a routable address.
 */
function healthCheckHost(host: string): string {
  if (host === "0.0.0.0" || host === "") return "127.0.0.1";
  if (host === "::" || host === "::0") return "::1";
  return host;
}

function formatUrl(host: string, port: number): string {
  // Bracket IPv6 literals in URLs.
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function isToolsServerHealthy(
  port: number,
  host: string = "127.0.0.1",
  timeoutMs = 2000,
  token?: string
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${formatUrl(healthCheckHost(host), port)}/tools`, {
      signal: controller.signal,
      headers: authHeaders(token),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface SpawnToolsServerOptions extends BuildToolsServerEnvOptions {}

export function spawnToolsServer(
  paths: ToolsServerPaths,
  port: number,
  options: SpawnToolsServerOptions = {}
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
      env: buildToolsServerEnv(paths, port, process.env, options),
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
      // Match: "Tools server listening on http://<host>:<port>"
      // Greedy `.+` then `:digits` backtracks to the trailing port, so this
      // works for hostnames, IPv4 (`127.0.0.1`), and bracketed IPv6 (`[::1]`).
      const match = line.match(/Tools server listening on http:\/\/.+:(\d+)/);
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

export async function readToolsServerState(): Promise<ToolsServerState | null> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return JSON.parse(raw) as ToolsServerState;
  } catch {
    return null;
  }
}

export async function writeToolsServerState(state: ToolsServerState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  // Atomic publish: write a per-process temp file, force 0600 (writeFile's
  // `mode` only applies on create, so chmod also covers a stale temp), then
  // rename over STATE_FILE. rename(2) within the same dir is atomic, so a
  // concurrent reader (another launcher, `argent server status`, the running
  // global MCP) never observes a missing / half-written / looser-perm state
  // file, and the auth token is never published at a world-readable mode.
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(tmp, 0o600);
    await rename(tmp, STATE_FILE);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Sync counterpart of {@link writeToolsServerState}. The CLI's foreground
 * `server start` path uses this to land the state file before any async
 * `child.on("exit")` event can fire, which would otherwise race the write
 * and leave a stale file pointing at a dead pid. Written 0600 to match the
 * async path (the state file may hold an auth token).
 */
export function writeToolsServerStateSync(state: ToolsServerState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(STATE_FILE, 0o600);
}

export async function clearToolsServerState(): Promise<void> {
  try {
    await unlink(STATE_FILE);
  } catch {
    // already gone
  }
}

const readState = readToolsServerState;
const writeState = writeToolsServerState;
const clearState = clearToolsServerState;

// SIGTERM grace matches tool-server's own PROCESS_TIMEOUT_MS (5 s) plus a small
// buffer so we let the server's graceful shutdown (HTTP drain + registry
// dispose) finish before escalating. Without this wait, a fast restart can
// race the OS releasing the listening port and the next spawn hits EADDRINUSE.
const SIGTERM_GRACE_MS = 6_000;
const SIGKILL_GRACE_MS = 1_000;
const KILL_POLL_MS = 100;

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise<void>((r) => setTimeout(r, KILL_POLL_MS));
  }
  return !isProcessAlive(pid);
}

export async function killToolServer(): Promise<void> {
  const state = await readState();
  if (!state) return;

  let exited = !isProcessAlive(state.pid);
  if (!exited) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // Process disappeared between the alive check and the signal — fine.
      exited = true;
    }
  }

  if (!exited) {
    exited = await waitForExit(state.pid, SIGTERM_GRACE_MS);
  }

  if (!exited) {
    // SIGTERM ignored or shutdown hung. Force.
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      exited = true;
    }
    if (!exited) {
      await waitForExit(state.pid, SIGKILL_GRACE_MS);
    }
  }

  await clearState();
}

export async function ensureToolsServer(paths: ToolsServerPaths): Promise<ToolsServerHandle> {
  const state = await readState();

  if (state) {
    const alive = isProcessAlive(state.pid);
    if (alive) {
      const host = state.host ?? "127.0.0.1";
      const healthy = await isToolsServerHealthy(state.port, host, 2000, state.token);
      if (healthy) {
        return {
          url: formatUrl(healthCheckHost(host), state.port),
          token: state.token ?? "",
        };
      }
    }
    await clearState();
  }

  // Spawn a new server with a fresh token. Auto-spawned servers always
  // authenticate (the token is local to this user and persisted 0600).
  const token = generateToken();
  const port = await findFreePort();
  const { port: actualPort, pid } = await spawnToolsServer(paths, port, {
    token,
    idleTimeoutMinutes: AUTOSPAWN_IDLE_TIMEOUT_MINUTES,
  });

  await writeState({
    port: actualPort,
    pid,
    startedAt: new Date().toISOString(),
    bundlePath: paths.bundlePath,
    host: "127.0.0.1",
    token,
  });

  return { url: formatUrl("127.0.0.1", actualPort), token };
}

export const STATE_PATHS = { STATE_DIR, STATE_FILE, LOG_FILE };

export { formatUrl as formatToolsServerUrl };
