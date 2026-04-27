import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { killToolServer } from "../launcher.js";

const STATE_DIR = path.join(homedir(), ".argent");
const STATE_FILE = path.join(STATE_DIR, "tool-server.json");
const LOG_FILE = path.join(STATE_DIR, "tool-server.log");

interface ToolsServerState {
  port: number;
  pid: number;
  startedAt: string;
  bundlePath: string;
}

function readState(): ToolsServerState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as ToolsServerState;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy(port: number, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tools`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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
  const alive = isProcessAlive(state.pid);
  const healthy = alive ? await isHealthy(state.port) : false;
  if (json) {
    console.log(JSON.stringify({ running: alive && healthy, ...state, alive, healthy }, null, 2));
    return;
  }
  console.log(`tool-server:`);
  console.log(`  url:        http://127.0.0.1:${state.port}`);
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

export async function server(argv: string[]): Promise<void> {
  const sub = argv[0];
  const json = argv.includes("--json");
  const follow = argv.includes("-f") || argv.includes("--follow");

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`Usage:
  argent server status [--json]   Show tool-server pid, port, and health
  argent server stop              Terminate the running tool-server
  argent server logs [-f]         Print (or follow) the tool-server log
`);
    return;
  }

  switch (sub) {
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
