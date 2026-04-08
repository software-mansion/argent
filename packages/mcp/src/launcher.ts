import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";

const STATE_DIR = path.join(homedir(), ".argent");
const STATE_FILE = path.join(STATE_DIR, "tool-server.json");
const LOG_FILE = path.join(STATE_DIR, "tool-server.log");

const LAUNCHD_LABEL = "com.argent.tool-server";
const PLIST_DIR = path.join(homedir(), "Library", "LaunchAgents");
const PLIST_FILE = path.join(PLIST_DIR, `${LAUNCHD_LABEL}.plist`);

// __dirname in ESM (compiled from TS) will be dist/
export const BUNDLED_RUNTIME_PATHS = {
  bundlePath: path.join(import.meta.dirname, "tool-server.cjs"),
  simulatorServerDir: path.join(import.meta.dirname, "..", "bin"),
  nativeDevtoolsDir: path.join(import.meta.dirname, "..", "dylibs"),
};

const BUNDLE_PATH = BUNDLED_RUNTIME_PATHS.bundlePath;

export function buildToolsServerEnv(
  port: number,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    PORT: String(port),
    ARGENT_SIMULATOR_SERVER_DIR: BUNDLED_RUNTIME_PATHS.simulatorServerDir,
    ARGENT_NATIVE_DEVTOOLS_DIR: BUNDLED_RUNTIME_PATHS.nativeDevtoolsDir,
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

function resolveNodePath(): string {
  try {
    return execFileSync("which", ["node"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
}

function pickSystemEnv(): Record<string, string> {
  const keys = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG"] as const;
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

function buildPlist(port: number): string {
  const nodePath = resolveNodePath();
  const env = buildToolsServerEnv(port, pickSystemEnv());

  const envEntries = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(
      ([k, v]) =>
        `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(String(v))}</string>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(BUNDLE_PATH)}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>

  <key>StandardOutPath</key>
  <string>${escapeXml(LOG_FILE)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(LOG_FILE)}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bootoutDaemon(): void {
  const uid = process.getuid?.() ?? 501;
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], {
      stdio: "ignore",
    });
  } catch {
    // Service may not be loaded — that's fine.
  }
}

function bootstrapDaemon(): void {
  const uid = process.getuid?.() ?? 501;
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST_FILE], {
    stdio: "ignore",
  });
}

function getDaemonPid(): number | null {
  try {
    const output = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`], {
      encoding: "utf8",
    });
    const match = output.match(/pid\s*=\s*(\d+)/);
    return match ? parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

async function waitForHealthy(port: number, timeoutMs: number = 15_000): Promise<void> {
  const start = Date.now();
  const interval = 200;

  while (Date.now() - start < timeoutMs) {
    if (await isHealthy(port)) return;
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error("Timed out waiting for tool-server daemon to become healthy");
}

async function launchToolsServer(port: number): Promise<{ port: number; pid: number }> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(PLIST_DIR, { recursive: true });

  // Remove any previously loaded instance of this daemon.
  bootoutDaemon();

  const plistContent = buildPlist(port);
  fs.writeFileSync(PLIST_FILE, plistContent, "utf8");

  bootstrapDaemon();

  await waitForHealthy(port);

  const pid = getDaemonPid();
  if (pid == null || pid <= 0) {
    throw new Error(
      "tool-server daemon was bootstrapped but its PID could not be determined"
    );
  }

  return { port, pid };
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

async function removePlist(): Promise<void> {
  try {
    await unlink(PLIST_FILE);
  } catch {
    // already gone
  }
}

export async function killToolServer(): Promise<void> {
  bootoutDaemon();
  await removePlist();
  await clearState();
}

export async function ensureToolsServer(): Promise<string> {
  const state = await readState();

  if (state) {
    const alive = isProcessAlive(state.pid);
    if (alive) {
      const healthy = await isHealthy(state.port);
      if (healthy) {
        return `http://127.0.0.1:${state.port}`;
      }
    }
    // Stale state — clean up before re-launching.
    bootoutDaemon();
    await clearState();
  }

  // Launch a new daemon.
  const port = await findFreePort();
  const { port: actualPort, pid } = await launchToolsServer(port);

  await writeState({
    port: actualPort,
    pid,
    startedAt: new Date().toISOString(),
    bundlePath: BUNDLE_PATH,
  });

  return `http://127.0.0.1:${actualPort}`;
}
