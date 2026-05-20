import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { ensureCdpReachable } from "../../blueprints/electron-cdp";
import { electronIdFromPort } from "../../utils/device-info";
import { trackElectronPort } from "../../utils/electron-discovery";

export interface ElectronBootResult {
  platform: "electron";
  id: string;
  port: number;
  pid: number;
  appPath: string;
  booted: true;
}

interface BootElectronOptions {
  appPath: string;
  port?: number;
  extraArgs?: string[];
  /** Defaults to 30s. */
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** Pick a free localhost port the kernel hands out. */
async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not allocate a free TCP port")));
      }
    });
  });
}

/**
 * Pick the Electron binary to spawn:
 *  - If `appPath` is a directory, look for `node_modules/.bin/electron` inside it.
 *  - If it's a packaged macOS .app bundle, return its Contents/MacOS/<exec> path.
 *  - Otherwise assume the path itself is the executable.
 *
 * Returns `{ command, args }` where args are the prefix BEFORE the user's --remote-debugging-port flag.
 */
function resolveLauncher(appPath: string): { command: string; args: string[] } {
  const abs = path.resolve(appPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Electron boot: path does not exist: ${abs}`);
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    if (abs.endsWith(".app")) {
      // macOS packaged app bundle. Read Contents/Info.plist's CFBundleExecutable
      // for the real binary name; fall back to the basename.
      const macOsDir = path.join(abs, "Contents", "MacOS");
      if (!fs.existsSync(macOsDir)) {
        throw new Error(
          `Electron boot: ${abs} is a .app bundle but has no Contents/MacOS. ` +
            `Pass the inner binary directly, or use the project directory of an unpackaged app.`
        );
      }
      const entries = fs.readdirSync(macOsDir).filter((name) => !name.startsWith("."));
      if (entries.length === 0) {
        throw new Error(`Electron boot: ${macOsDir} is empty.`);
      }
      // Prefer one matching the .app folder name, otherwise take the first.
      const bundleName = path.basename(abs, ".app");
      const exec = entries.find((n) => n === bundleName) ?? entries[0]!;
      return { command: path.join(macOsDir, exec), args: [] };
    }
    // Unpackaged project directory — use ./node_modules/.bin/electron if present.
    const localBin = path.join(abs, "node_modules", ".bin", "electron");
    if (fs.existsSync(localBin)) {
      return { command: localBin, args: [abs] };
    }
    // Fall back to PATH-resolved `electron`.
    return { command: "electron", args: [abs] };
  }
  // A file — assume it's executable.
  return { command: abs, args: [] };
}

async function waitForCdpReady(port: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      await ensureCdpReachable(port);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Electron CDP never became reachable on port ${port} within ${deadlineMs}ms. ${detail}`
  );
}

/**
 * Spawn an Electron app and wait until its CDP endpoint is responding.
 *
 * The child is detached so the tool-server's lifecycle does not own it — the
 * caller manages the app process explicitly through Electron's own quit /
 * close-window flows. We `unref()` the process; closing the tool-server does
 * not bring the app down (matching the simulator-server pattern where the
 * simulator outlives the bridge).
 */
export async function bootElectronApp(options: BootElectronOptions): Promise<ElectronBootResult> {
  const port = options.port ?? (await pickFreePort());
  const launcher = resolveLauncher(options.appPath);
  const extra = options.extraArgs ?? [];

  const args = [...launcher.args, `--remote-debugging-port=${port}`, ...extra];

  let child: ChildProcess;
  try {
    child = spawn(launcher.command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    });
  } catch (err) {
    throw new Error(
      `Electron boot: failed to spawn ${launcher.command}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!child.pid) {
    throw new Error(`Electron boot: spawn returned without a pid (binary: ${launcher.command}).`);
  }

  // Forward Electron stderr to our stderr so launch failures are visible to
  // the user / agent. Drop stdout (renderer chatter) to keep tool-server logs clean.
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[electron-cdp-${port}] ${chunk}`);
  });
  child.unref();

  try {
    await waitForCdpReady(port, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  } catch (err) {
    // CDP didn't come up — terminate the orphan so we don't leak a process.
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    throw err;
  }

  trackElectronPort(port);

  return {
    platform: "electron",
    id: electronIdFromPort(port),
    port,
    pid: child.pid,
    appPath: path.resolve(options.appPath),
    booted: true,
  };
}
