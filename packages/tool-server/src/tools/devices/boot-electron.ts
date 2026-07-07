import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { ensureCdpReachable } from "../../blueprints/chromium-cdp";
import { chromiumIdFromPort } from "../../utils/device-info";
import { trackChromiumPort } from "../../utils/chromium-discovery";
import { electronGuiChildEnv } from "../../utils/electron-env";

// Booting an Electron app is one way to produce a Chromium/CDP device: the
// launched process is a Chromium runtime exposing a CDP endpoint, so the
// resulting device id, platform, and tool surface are all the generic
// `chromium` ones. This file stays "electron"-named because the *launcher*
// is Electron-specific (it resolves an Electron binary / .app bundle); the
// device it yields is not.
export interface ElectronBootResult {
  platform: "chromium";
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
    throw new FailureError(`Electron boot: path does not exist: ${abs}`, {
      error_code: FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID,
      failure_stage: "electron_app_path_missing",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    if (abs.endsWith(".app")) {
      // macOS packaged app bundle. Read Contents/Info.plist's CFBundleExecutable
      // for the real binary name; fall back to the basename.
      const macOsDir = path.join(abs, "Contents", "MacOS");
      if (!fs.existsSync(macOsDir)) {
        throw new FailureError(
          `Electron boot: ${abs} is a .app bundle but has no Contents/MacOS. ` +
            `Pass the inner binary directly, or use the project directory of an unpackaged app.`,
          {
            error_code: FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID,
            failure_stage: "electron_app_bundle_invalid",
            failure_area: "tool_server",
            error_kind: "validation",
          }
        );
      }
      const entries = fs.readdirSync(macOsDir).filter((name) => !name.startsWith("."));
      if (entries.length === 0) {
        throw new FailureError(`Electron boot: ${macOsDir} is empty.`, {
          error_code: FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID,
          failure_stage: "electron_app_bundle_empty",
          failure_area: "tool_server",
          error_kind: "validation",
        });
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
  throw new FailureError(
    `Electron CDP never became reachable on port ${port} within ${deadlineMs}ms. ${detail}`,
    {
      error_code: FAILURE_CODES.CHROMIUM_ELECTRON_CDP_TIMEOUT,
      failure_stage: "electron_cdp_ready",
      failure_area: "tool_server",
      error_kind: "timeout",
    },
    { cause: lastErr instanceof Error ? lastErr : undefined }
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
/**
 * Strip user-supplied --remote-debugging-port from extraArgs so the caller
 * can't accidentally point Electron at a different CDP port than the one we
 * tracked and reported back. Last-wins on Chromium's flag parser, so a stray
 * override would otherwise silently break list-devices / interaction tools.
 */
function sanitizeExtraArgs(extra: string[]): string[] {
  return extra.filter((a) => {
    if (a === "--remote-debugging-port" || a.startsWith("--remote-debugging-port=")) {
      process.stderr.write(
        `[electron-boot] dropping user-supplied "${a}" — Argent manages the CDP port.\n`
      );
      return false;
    }
    return true;
  });
}

function killChildEscalating(child: ChildProcess): void {
  // SIGTERM lets Electron flush the renderer's GPU buffers and write a clean
  // exit code; SIGKILL after 2s catches stuck processes (hardware-accelerated
  // GPU shutdown can deadlock on some Intel drivers).
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 2000).unref();
}

/**
 * Terminate a Chromium/Electron app by pid — the only handle left once
 * {@link bootElectronApp} returns (the child is detached + unref'd). Same
 * escalation as {@link killChildEscalating}: SIGTERM, then SIGKILL after a grace
 * period. An already-exited process is a no-op, not an error.
 */
export function killChromiumByPid(pid: number): void {
  if (signalPid(pid, "SIGTERM") === "gone") return; // already exited, nothing to escalate
  setTimeout(() => {
    signalPid(pid, "SIGKILL");
  }, 2000).unref();
}

/** Send a signal to a pid, reporting "gone" on ESRCH (no such process). */
function signalPid(pid: number, signal: NodeJS.Signals): "sent" | "gone" {
  try {
    process.kill(pid, signal);
    return "sent";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "sent";
  }
}

export async function bootElectronApp(options: BootElectronOptions): Promise<ElectronBootResult> {
  const port = options.port ?? (await pickFreePort());
  const launcher = resolveLauncher(options.appPath);
  const extra = sanitizeExtraArgs(options.extraArgs ?? []);

  const args = [...launcher.args, `--remote-debugging-port=${port}`, ...extra];

  let child: ChildProcess;
  try {
    child = spawn(launcher.command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Strip ELECTRON_RUN_AS_NODE (see electronGuiChildEnv): if the tool-server
      // inherited it from an Electron-based MCP host, the Electron binary would
      // run in Node mode with no CDP endpoint — so boot-device fails below (the
      // child exits early, or the readiness probe times out) instead of the app
      // coming up.
      env: electronGuiChildEnv({ ELECTRON_ENABLE_LOGGING: "1" }),
    });
  } catch (err) {
    throw new FailureError(
      `Electron boot: failed to spawn ${launcher.command}: ${err instanceof Error ? err.message : String(err)}`,
      {
        error_code: FAILURE_CODES.CHROMIUM_ELECTRON_SPAWN_FAILED,
        failure_stage: "electron_spawn",
        failure_area: "tool_server",
        error_kind: "subprocess",
        ...subprocessFailureMetadata(err, "electron"),
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }

  // Attach the `error` listener BEFORE checking pid / wiring anything else.
  // Node's `spawn()` returns synchronously, but ENOENT / EACCES / EAGAIN are
  // delivered as a deferred `'error'` event on the next tick. EventEmitter
  // convention: an unhandled `error` event escapes as an uncaught exception —
  // here that would crash the entire tool-server every time someone called
  // boot-device with `electronAppPath` on a host that doesn't have electron
  // on PATH. Fold the event into the readiness race so the caller sees a
  // clean rejection instead.
  const onSpawnError = (err: NodeJS.ErrnoException, reject: (e: Error) => void) => {
    const codeSuffix = err.code ? ` (${err.code})` : "";
    reject(
      new FailureError(
        `Electron boot: failed to launch ${launcher.command}${codeSuffix}: ${err.message}. ` +
          `Make sure 'electron' is installed (npm i electron in the app dir, or globally) and on PATH.`,
        {
          error_code: FAILURE_CODES.CHROMIUM_ELECTRON_SPAWN_FAILED,
          failure_stage: "electron_spawn_error",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "electron"),
        },
        { cause: err }
      )
    );
  };
  let spawnErrorReject: ((e: Error) => void) | null = null;
  const spawnError = new Promise<never>((_resolve, reject) => {
    spawnErrorReject = reject;
  });
  const spawnErrorListener = (err: NodeJS.ErrnoException) => {
    if (spawnErrorReject) onSpawnError(err, spawnErrorReject);
  };
  child.once("error", spawnErrorListener);

  if (!child.pid) {
    // No pid + no async error yet is still possible on some platforms when
    // spawn fails very early. Detach the error listener before throwing so a
    // deferred `'error'` event delivered after this synchronous throw doesn't
    // resolve onto an orphan promise (which Node would surface as an
    // UnhandledPromiseRejection and — with default --unhandled-rejections=throw
    // — crash the tool-server).
    child.removeListener("error", spawnErrorListener);
    spawnErrorReject = null;
    throw new FailureError(
      `Electron boot: spawn returned without a pid (binary: ${launcher.command}).`,
      {
        error_code: FAILURE_CODES.CHROMIUM_ELECTRON_SPAWN_FAILED,
        failure_stage: "electron_spawn_no_pid",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "electron",
      }
    );
  }

  // Forward Electron stderr to our stderr so launch failures are visible to
  // the user / agent. Drop stdout (renderer chatter) to keep tool-server logs clean.
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[chromium-cdp-${port}] ${chunk}`);
  });
  child.unref();

  // Race the readiness probe against the child's exit event. If the process
  // dies before CDP comes up (e.g. main.js crashes during startup), without
  // this race the caller would see a generic readiness-timeout error 30s
  // later instead of "process exited with code N".
  //
  // Both onExit and the earlier spawnErrorListener stay attached to the child
  // for the duration of Promise.race below. After we resolve (success OR
  // failure), they MUST be detached: the child is detached + unref'd, so it
  // outlives this function. A natural exit later (e.g. user closes the
  // Electron window) would otherwise reject the orphan `earlyExit` promise
  // with "exited with code 0" → unhandled rejection → tool-server crash.
  // Same shape as the no-pid throw path above, just for the steady-state run.
  let earlyExitReject: ((e: Error) => void) | null = null;
  const earlyExit = new Promise<never>((_resolve, reject) => {
    earlyExitReject = reject;
  });
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!earlyExitReject) return;
    const reason = signal ? `signal ${signal}` : `code ${code ?? "?"}`;
    earlyExitReject(
      new FailureError(
        `Electron boot: child process exited with ${reason} before CDP was ready. Inspect [chromium-cdp-${port}] stderr above for the cause.`,
        {
          error_code: FAILURE_CODES.CHROMIUM_ELECTRON_EXITED_BEFORE_READY,
          failure_stage: "electron_early_exit",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata({ code, signal }, "electron"),
        }
      )
    );
  };
  child.once("exit", onExit);

  const detachBootListeners = () => {
    child.removeListener("error", spawnErrorListener);
    child.removeListener("exit", onExit);
    spawnErrorReject = null;
    earlyExitReject = null;
  };

  try {
    await Promise.race([
      waitForCdpReady(port, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
      earlyExit,
      spawnError,
    ]);
  } catch (err) {
    // CDP didn't come up — terminate the orphan so we don't leak a process.
    // Detach the boot listeners first so the impending kill→exit doesn't
    // chain into a stale earlyExit rejection.
    //
    // INVARIANT: detachBootListeners() MUST be the first synchronous
    // statement in this catch block — no awaits before it. The boot-time
    // listeners would otherwise keep firing during any awaited cleanup and
    // re-introduce the orphan-rejection bug this commit closes.
    detachBootListeners();
    killChildEscalating(child);
    throw err;
  }
  // Happy path: detach the boot-time listeners now that race has resolved.
  // The child is intentionally long-lived; any later exit / error belongs
  // to whatever code subsequently manages the session, not to this boot fn.
  detachBootListeners();

  trackChromiumPort(port);

  return {
    platform: "chromium",
    id: chromiumIdFromPort(port),
    port,
    pid: child.pid,
    appPath: path.resolve(options.appPath),
    booted: true,
  };
}
