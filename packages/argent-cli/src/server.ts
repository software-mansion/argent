import * as fs from "node:fs";
import * as path from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import {
  killToolServer,
  findFreePort,
  spawnToolsServer,
  buildToolsServerEnv,
  isToolsServerHealthy,
  isToolsServerProcessAlive,
  readToolsServerState,
  readAllToolsServerStates,
  writeToolsServerState,
  writeToolsServerStateSync,
  clearToolsServerState,
  formatToolsServerUrl,
  formatLinkUrl,
  generateAuthToken,
  type ToolsServerPaths,
} from "@argent/tools-client";

const STATE_DIR = path.join(homedir(), ".argent");
const LOG_FILE = path.join(STATE_DIR, "tool-server.log");

// State records are tracked per argent install (per tool-server bundle), so
// status/stop always target the server belonging to THIS binary — never a
// different install's server that happens to be running on the same machine.

/** One-line hint when other installs' servers are alive but ours is not. */
async function describeForeignServers(ownBundlePath?: string): Promise<string | null> {
  const others = (await readAllToolsServerStates()).filter(
    ({ state }) => state.bundlePath !== ownBundlePath && isToolsServerProcessAlive(state.pid)
  );
  if (others.length === 0) return null;
  const list = others
    .map(({ state }) => `pid ${state.pid} (${state.bundlePath})`)
    .join(", ");
  return `Note: ${others.length} tool-server(s) from other argent installs: ${list}`;
}

async function statusCmd(json: boolean, paths?: ToolsServerPaths): Promise<void> {
  const state = await readToolsServerState(paths?.bundlePath);
  if (!state) {
    const foreign = await describeForeignServers(paths?.bundlePath);
    if (json) {
      console.log(JSON.stringify({ running: false }, null, 2));
    } else {
      console.log("tool-server: not running (no state file for this install)");
      if (foreign) console.log(foreign);
    }
    return;
  }
  const host = state.host ?? "127.0.0.1";
  const alive = isToolsServerProcessAlive(state.pid);
  const healthy = alive ? await isToolsServerHealthy(state.port, host, 2000, state.token) : false;
  if (json) {
    // Hide the token from JSON output — it's a secret. Surface its presence
    // without leaking the value.
    const { token, ...publicState } = state;
    console.log(
      JSON.stringify(
        { running: alive && healthy, ...publicState, hasToken: !!token, alive, healthy },
        null,
        2
      )
    );
    return;
  }
  console.log(`tool-server:`);
  console.log(`  url:        ${formatToolsServerUrl(host, state.port)}`);
  console.log(`  pid:        ${state.pid}`);
  console.log(`  startedAt:  ${state.startedAt}`);
  console.log(`  process:    ${alive ? "alive" : "dead"}`);
  console.log(`  health:     ${healthy ? "ok" : "unreachable"}`);
  if (!alive || !healthy) {
    console.log(`\nState file is stale; next \`argent\` invocation will respawn the server.`);
  }
}

async function stopCmd(paths?: ToolsServerPaths): Promise<void> {
  const state = await readToolsServerState(paths?.bundlePath);
  if (!state) {
    console.log("tool-server: not running");
    const foreign = await describeForeignServers(paths?.bundlePath);
    if (foreign) console.log(`${foreign}\nStop one with: kill <pid>`);
    return;
  }
  await killToolServer(paths?.bundlePath);
  console.log(`tool-server stopped (pid ${state.pid}).`);
}

function logsCmd(follow: boolean): void {
  if (!fs.existsSync(LOG_FILE)) {
    console.log(`No log file at ${LOG_FILE}`);
    return;
  }
  if (!follow) {
    process.stdout.write(fs.readFileSync(LOG_FILE, "utf8"));
    return;
  }
  // -f: tail -f equivalent. Spawning `tail` keeps this small and behaves the
  // same as the user's terminal expects (Ctrl-C to exit).
  const child = spawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

export interface StartFlags {
  port: number | null;
  host: string;
  idleTimeoutMinutes: number;
  detach: boolean;
  force: boolean;
  /** Disable auth (no token minted). Server accepts unauthenticated requests. */
  noAuth: boolean;
  help: boolean;
}

export class StartFlagError extends Error {}

export function parseStartFlags(argv: string[]): StartFlags {
  const flags: StartFlags = {
    port: null,
    host: "127.0.0.1",
    idleTimeoutMinutes: 0,
    detach: false,
    force: false,
    noAuth: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const takeValue = (name: string): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new StartFlagError(`${name} requires a value`);
      i += 1;
      return v;
    };
    if (tok === "--help" || tok === "-h") {
      flags.help = true;
      continue;
    }
    if (tok === "--detach" || tok === "-d") {
      flags.detach = true;
      continue;
    }
    if (tok === "--force") {
      flags.force = true;
      continue;
    }
    if (tok === "--no-auth") {
      flags.noAuth = true;
      continue;
    }
    if (tok === "--port" || tok === "-p") {
      flags.port = parsePort(takeValue("--port"));
      continue;
    }
    if (tok.startsWith("--port=")) {
      flags.port = parsePort(tok.slice("--port=".length));
      continue;
    }
    if (tok === "--host") {
      flags.host = takeValue("--host");
      continue;
    }
    if (tok.startsWith("--host=")) {
      flags.host = tok.slice("--host=".length);
      continue;
    }
    if (tok === "--idle-timeout") {
      flags.idleTimeoutMinutes = parseIdle(takeValue("--idle-timeout"));
      continue;
    }
    if (tok.startsWith("--idle-timeout=")) {
      flags.idleTimeoutMinutes = parseIdle(tok.slice("--idle-timeout=".length));
      continue;
    }
    throw new StartFlagError(`Unknown flag: ${tok}`);
  }

  return flags;
}

// Require digits only — rejects empty strings, signs, decimals, hex, scientific
// notation, and trailing that `parseInt` would silently truncate
// (e.g. `--port=123abc` parsing as 123).
const NON_NEGATIVE_INT = /^\d+$/;

export function parsePort(raw: string): number {
  if (!NON_NEGATIVE_INT.test(raw) || Number(raw) > 65535) {
    throw new StartFlagError(`--port must be an integer 0..65535, got "${raw}"`);
  }
  return Number(raw);
}

export function parseIdle(raw: string): number {
  if (!NON_NEGATIVE_INT.test(raw)) {
    throw new StartFlagError(`--idle-timeout must be a non-negative integer, got "${raw}"`);
  }
  return Number(raw);
}

function printStartHelp(): void {
  console.log(`Usage: argent server start [flags]

Spawn a long-lived tool-server. Foreground by default so process supervisors
(systemd, Docker, supervisord) can own the lifecycle.

Flags:
  --port, -p <n>          Bind to port <n> (0 = pick a free port). Default: 3001
  --host <h>              Bind address. Default: 127.0.0.1
                          Use 0.0.0.0 to expose on every interface.
  --idle-timeout <m>      Auto-shutdown after <m> idle minutes (0 disables).
                          Default: 0 (never auto-shutdown).
  --detach, -d            Run as a detached background process and return.
  --force                 If a tool-server is already running, kill it first.
  --no-auth               Disable authentication (no token). Anyone who can
                          reach the port can drive the server. Dev/trusted only.
  --help, -h              Show this help.

Auth:
  By default the server mints a bearer token and prints a one-line connection
  string. Pair a client by pasting it into \`argent link\`:
      argent link argent://<token>@<host>:<port>
  Pass --no-auth to run without a token (unauthenticated).

Examples:
  argent server start
  argent server start --port 4000
  argent server start --host 0.0.0.0 --port 4000
  argent server start --detach
  argent server start --host 0.0.0.0 --no-auth
`);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isWildcard(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "::0" || host === "";
}

/** First non-internal IPv4 address, for suggesting a reachable host when bound
 * to a wildcard address. Null when none is found (e.g. offline). */
function primaryLanIPv4(): string | null {
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const ni of addrs ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}

/** Host a client should connect to, given what the server bound to. */
function resolveConnectHost(bindHost: string): string {
  if (isWildcard(bindHost)) return primaryLanIPv4() ?? "127.0.0.1";
  return bindHost;
}

/**
 * Print the copy-pasteable pairing block: the `argent://` connection string
 * (headline) plus the explicit-flags fallback for scripting.
 */
function printConnectionInfo(bindHost: string, port: number, token?: string): void {
  const connectHost = resolveConnectHost(bindHost);
  console.log("");
  console.log("  Connect a client:");
  console.log(`      argent link ${formatLinkUrl({ host: connectHost, port, token })}`);
  const flagsForm = token
    ? `argent link --host ${connectHost} --port ${port} --token ${token}`
    : `argent link --host ${connectHost} --port ${port}`;
  console.log(`      (or: ${flagsForm})${token ? "" : "   [unauthenticated]"}`);
  if (isWildcard(bindHost)) {
    console.log(
      `  note: bound to ${bindHost}; ${connectHost} is a best guess — replace it ` +
        `with the address clients actually reach this machine on.`
    );
  }
}

async function ensureNoExistingServer(force: boolean, paths: ToolsServerPaths): Promise<void> {
  const state = await readToolsServerState(paths.bundlePath);
  if (!state) return;
  const alive = isToolsServerProcessAlive(state.pid);
  const healthy = alive ? await isToolsServerHealthy(state.port, state.host ?? "127.0.0.1") : false;
  if (alive && healthy && !force) {
    const url = formatToolsServerUrl(state.host ?? "127.0.0.1", state.port);
    throw new StartFlagError(
      `tool-server is already running at ${url} (pid ${state.pid}).\n` +
        `Use \`argent server stop\` first, or pass \`--force\` to replace it.`
    );
  }
  if (alive && force) {
    await killToolServer(paths.bundlePath);
  } else {
    // Stale state file — clear it so we don't leave it pointing at a dead pid.
    await clearToolsServerState(paths.bundlePath);
  }
}

async function resolvePort(requested: number | null): Promise<number> {
  if (requested === null) return 3001;
  if (requested === 0) return findFreePort();
  return requested;
}

async function startCmd(argv: string[], paths: ToolsServerPaths | undefined): Promise<void> {
  if (!paths) {
    console.error("argent server start: bundled runtime paths missing — this build is incomplete.");
    process.exit(1);
  }

  let flags: StartFlags;
  try {
    flags = parseStartFlags(argv);
  } catch (err) {
    if (err instanceof StartFlagError) {
      console.error(`Error: ${err.message}\n`);
      printStartHelp();
      process.exit(2);
    }
    throw err;
  }

  if (flags.help) {
    printStartHelp();
    return;
  }

  try {
    await ensureNoExistingServer(flags.force, paths);
  } catch (err) {
    if (err instanceof StartFlagError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const port = await resolvePort(flags.port);

  // Auth on by default; --no-auth opts out (token stays undefined → the
  // tool-server runs unauthenticated and prints its own warning).
  const token = flags.noAuth ? undefined : generateAuthToken();

  if (!isLoopback(flags.host)) {
    if (token) {
      process.stderr.write(
        `Note: tool-server will be reachable on ${flags.host}:${port} over plain HTTP ` +
          `(bearer-token auth, no TLS). Keep it to a trusted network or VPN.\n`
      );
    } else {
      process.stderr.write(
        `WARNING: tool-server will be reachable on ${flags.host}:${port} with NO auth ` +
          `(--no-auth) — anyone who can reach the port can drive it. Do not expose ` +
          `to untrusted networks.\n`
      );
    }
  }

  if (flags.detach) {
    await runDetached(paths, port, flags.host, flags.idleTimeoutMinutes, token);
    return;
  }

  await runForeground(paths, port, flags.host, flags.idleTimeoutMinutes, token);
}

async function runDetached(
  paths: ToolsServerPaths,
  port: number,
  host: string,
  idleTimeoutMinutes: number,
  token?: string
): Promise<void> {
  const { port: actualPort, pid } = await spawnToolsServer(paths, port, {
    host,
    idleTimeoutMinutes,
    token,
  });
  await writeToolsServerState({
    port: actualPort,
    pid,
    startedAt: new Date().toISOString(),
    bundlePath: paths.bundlePath,
    host,
    // Mark this as an explicitly-started (possibly supervisor-managed) server so
    // the MCP auto-spawn path's kill-before-respawn never terminates it.
    managed: "cli",
    ...(token ? { token } : {}),
  });
  const url = formatToolsServerUrl(host, actualPort);
  console.log(`tool-server started: ${url} (pid ${pid})`);
  printConnectionInfo(host, actualPort, token);
  console.log("");
  console.log(`  logs:   ${LOG_FILE}`);
  console.log(`  status: argent server status`);
  console.log(`  stop:   argent server stop`);
}

async function runForeground(
  paths: ToolsServerPaths,
  port: number,
  host: string,
  idleTimeoutMinutes: number,
  token?: string
): Promise<void> {
  const env = buildToolsServerEnv(paths, port, process.env, {
    host,
    idleTimeoutMinutes,
    token,
  });

  const child = spawn("node", [paths.bundlePath, "start"], {
    stdio: "inherit",
    env,
  });

  // Forward signals so process supervisors can stop us cleanly. The child has
  // its own SIGINT/SIGTERM handlers that drain HTTP + dispose the registry.
  const forward = (signal: NodeJS.Signals) => () => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  // Register state synchronously so a fast child exit (e.g. EADDRINUSE) cannot
  // race the write and leave a stale file pointing at a dead pid.
  let stateWritten = false;
  const childPid = child.pid;
  if (childPid !== undefined) {
    try {
      writeToolsServerStateSync({
        port,
        pid: childPid,
        startedAt: new Date().toISOString(),
        bundlePath: paths.bundlePath,
        host,
        // See runDetached: tag CLI-started servers so auto-spawn won't kill them.
        managed: "cli",
        ...(token ? { token } : {}),
      });
      stateWritten = true;
    } catch {
      /* non-fatal: foreground run still works without the state file */
    }
  }

  // Print the pairing block now, before the child's inherited stdout starts
  // streaming its own "listening on…" banner and log lines.
  printConnectionInfo(host, port, token);

  await new Promise<void>(() => {
    const cleanup = () => {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      if (stateWritten) {
        clearToolsServerState(paths.bundlePath).catch(() => {
          /* non-fatal */
        });
      }
    };
    // Spawn-level failures (ENOENT, EACCES) emit `error` instead of `exit` —
    // surface them cleanly so the user gets a real message, not a stack trace.
    child.on("error", (err) => {
      cleanup();
      console.error(`argent server start: failed to spawn tool-server: ${err.message}`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      // Mirror the child's exit. Signal-terminated children get conventional
      // 128+signo exit codes so shells / supervisors see the right outcome.
      const exitCode = code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0);
      process.exit(exitCode);
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number | null {
  const map: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 };
  return map[signal] ?? null;
}

export async function server(
  argv: string[],
  options?: { paths?: ToolsServerPaths }
): Promise<void> {
  const sub = argv[0];
  const json = argv.includes("--json");
  const follow = argv.includes("-f") || argv.includes("--follow");

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`Usage:
  argent server start [flags]     Spawn a long-lived tool-server (see --help)
  argent server status [--json]   Show tool-server pid, port, and health
  argent server stop              Terminate the running tool-server
  argent server logs [-f]         Print (or follow) the tool-server log
`);
    return;
  }

  switch (sub) {
    case "start":
      await startCmd(argv.slice(1), options?.paths);
      return;
    case "status":
      await statusCmd(json, options?.paths);
      return;
    case "stop":
      await stopCmd(options?.paths);
      return;
    case "logs":
      logsCmd(follow);
      return;
    default:
      console.error(`Unknown subcommand: server ${sub}`);
      process.exit(1);
  }
}
