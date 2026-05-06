import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import {
  killToolServer,
  findFreePort,
  spawnToolsServer,
  buildToolsServerEnv,
  isToolsServerHealthy,
  isToolsServerProcessAlive,
  readToolsServerState,
  writeToolsServerState,
  clearToolsServerState,
  formatToolsServerUrl,
  type ToolsServerPaths,
} from "@argent/tools-client";

const STATE_DIR = path.join(homedir(), ".argent");
const STATE_FILE = path.join(STATE_DIR, "tool-server.json");
const LOG_FILE = path.join(STATE_DIR, "tool-server.log");

interface ToolsServerState {
  port: number;
  pid: number;
  startedAt: string;
  bundlePath: string;
  host?: string;
}

function readState(): ToolsServerState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as ToolsServerState;
  } catch {
    return null;
  }
}

async function statusCmd(json: boolean): Promise<void> {
  const state = readState();
  if (!state) {
    if (json) {
      console.log(JSON.stringify({ running: false }, null, 2));
    } else {
      console.log("tool-server: not running (no state file)");
    }
    return;
  }
  const host = state.host ?? "127.0.0.1";
  const alive = isToolsServerProcessAlive(state.pid);
  const healthy = alive ? await isToolsServerHealthy(state.port, host) : false;
  if (json) {
    console.log(JSON.stringify({ running: alive && healthy, ...state, alive, healthy }, null, 2));
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

async function stopCmd(): Promise<void> {
  const state = readState();
  if (!state) {
    console.log("tool-server: not running");
    return;
  }
  await killToolServer();
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

interface StartFlags {
  port: number | null;
  host: string;
  idleTimeoutMinutes: number;
  detach: boolean;
  force: boolean;
  help: boolean;
}

class StartFlagError extends Error {}

function parseStartFlags(argv: string[]): StartFlags {
  const flags: StartFlags = {
    port: null,
    host: "127.0.0.1",
    idleTimeoutMinutes: 0,
    detach: false,
    force: false,
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

function parsePort(raw: string): number {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new StartFlagError(`--port must be an integer 0..65535, got "${raw}"`);
  }
  return n;
}

function parseIdle(raw: string): number {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new StartFlagError(`--idle-timeout must be a non-negative integer, got "${raw}"`);
  }
  return n;
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
  --help, -h              Show this help.

Examples:
  argent server start
  argent server start --port 4000
  argent server start --host 0.0.0.0 --port 4000
  argent server start --detach
`);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function ensureNoExistingServer(force: boolean): Promise<void> {
  const state = await readToolsServerState();
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
    await killToolServer();
  } else {
    // Stale state file — clear it so we don't leave it pointing at a dead pid.
    await clearToolsServerState();
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
    await ensureNoExistingServer(flags.force);
  } catch (err) {
    if (err instanceof StartFlagError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const port = await resolvePort(flags.port);

  if (!isLoopback(flags.host)) {
    process.stderr.write(
      `WARNING: tool-server will be reachable on ${flags.host}:${port} — ` +
        `do not expose to untrusted networks (no auth is enforced).\n`
    );
  }

  if (flags.detach) {
    await runDetached(paths, port, flags.host, flags.idleTimeoutMinutes);
    return;
  }

  await runForeground(paths, port, flags.host, flags.idleTimeoutMinutes);
}

async function runDetached(
  paths: ToolsServerPaths,
  port: number,
  host: string,
  idleTimeoutMinutes: number
): Promise<void> {
  const { port: actualPort, pid } = await spawnToolsServer(paths, port, {
    host,
    idleTimeoutMinutes,
  });
  await writeToolsServerState({
    port: actualPort,
    pid,
    startedAt: new Date().toISOString(),
    bundlePath: paths.bundlePath,
    host,
  });
  const url = formatToolsServerUrl(host, actualPort);
  console.log(`tool-server started: ${url} (pid ${pid})`);
  console.log(`  logs:   ${LOG_FILE}`);
  console.log(`  status: argent server status`);
  console.log(`  stop:   argent server stop`);
}

async function runForeground(
  paths: ToolsServerPaths,
  port: number,
  host: string,
  idleTimeoutMinutes: number
): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const env = buildToolsServerEnv(paths, port, process.env, {
    host,
    idleTimeoutMinutes,
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
      fs.writeFileSync(
        STATE_FILE,
        JSON.stringify(
          {
            port,
            pid: childPid,
            startedAt: new Date().toISOString(),
            bundlePath: paths.bundlePath,
            host,
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
      stateWritten = true;
    } catch {
      /* non-fatal: foreground run still works without the state file */
    }
  }

  await new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      if (stateWritten) {
        clearToolsServerState().catch(() => {
          /* non-fatal */
        });
      }
      // Mirror the child's exit. Signal-terminated children get conventional
      // 128+signo exit codes so shells / supervisors see the right outcome.
      const exitCode = code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0);
      process.exit(exitCode);
      resolve();
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
      await statusCmd(json);
      return;
    case "stop":
      await stopCmd();
      return;
    case "logs":
      logsCmd(follow);
      return;
    default:
      console.error(`Unknown subcommand: server ${sub}`);
      process.exit(1);
  }
}
