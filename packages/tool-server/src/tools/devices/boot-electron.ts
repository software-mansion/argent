import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { ensureCdpReachable } from "../../blueprints/chromium-cdp";
import { chromiumIdFromPort } from "../../utils/device-info";
import { trackChromiumPort } from "../../utils/chromium-discovery";
import { electronGuiChildEnv } from "../../utils/electron-env";

// An Electron app boots as a Chromium/CDP runtime, so the device id, platform
// and tool surface are the generic `chromium` ones; only the launcher here is
// Electron-specific.
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

/**
 * How long a successful readiness probe must hold before boot reports success.
 * An instance that loses Electron's single-instance lock opens its CDP listener
 * during startup and only then quits, so without the hold boot could name an
 * already-dead instance. Every successful boot pays this latency.
 */
const BOOT_CONFIRM_WINDOW_MS = 300;

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
 * Resolve the Electron binary for `appPath`: a `.app` bundle yields its
 * Contents/MacOS executable, a directory its local `node_modules/.bin/electron`
 * (else PATH `electron`), and a file is assumed to be the executable itself.
 * Returned `args` precede the `--remote-debugging-port` flag.
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
      const bundleName = path.basename(abs, ".app");
      const exec = entries.find((n) => n === bundleName) ?? entries[0]!;
      return { command: path.join(macOsDir, exec), args: [] };
    }
    const localBin = path.join(abs, "node_modules", ".bin", "electron");
    if (fs.existsSync(localBin)) {
      return { command: localBin, args: [abs] };
    }
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
 * Drop user-supplied --remote-debugging-port: Chromium honours the last
 * occurrence, so an override would leave Electron listening somewhere other
 * than the port we tracked and reported to the caller.
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

/**
 * Signal the whole process group led by `pid`, reporting whether anything was
 * there. Detached spawn makes the child its own group leader, so descendants
 * that survive a leader-only SIGTERM — an app trapping it in `before-quit`,
 * helpers outliving a wedged browser — are still reachable: survivors reparent
 * to init but keep their pgid.
 */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    // ESRCH = the group is empty; anything else (EPERM) means it isn't.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function killChildEscalating(child: ChildProcess): void {
  // SIGTERM through the handle lets Electron run its quit sequence and take its
  // helpers down with it; a group SIGTERM would hit every helper directly and
  // defeat that, so it is sent only once the handle is dead and child.kill
  // reaches nothing. SIGKILL after 2s catches processes stuck in shutdown.
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  if (child.pid !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
    signalGroup(child.pid, "SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Group liveness, not the leader's exit status, decides this escalation:
    // the leader routinely exits while a helper lives on. Probe-then-kill
    // leaves the same recycled-pgid window the raw-pid fallback documents.
    if (child.pid !== undefined && signalGroup(child.pid, 0)) {
      signalGroup(child.pid, "SIGKILL");
    }
  }, 2000).unref();
}

/**
 * ChildProcess handles for the Electron apps this tool-server booted, keyed by
 * CDP port. Killing through a handle lets {@link killChildEscalating} check
 * exit status, so its delayed SIGKILL can never land on a recycled pid (the
 * group sweep still relies on a liveness probe). Entries are dropped when the
 * child exits or a kill consumes them; holding a handle does not re-ref the
 * unref'd child.
 */
const liveChildren = new Map<number, ChildProcess>();

/**
 * Terminate a Chromium/Electron app this tool-server booted on `port`, via the
 * retained handle ({@link liveChildren}) when there is one, else best-effort
 * group signalling on the raw pid. An already-exited process is a no-op.
 *
 * `pid` must be a detached-spawn group leader: every signal here targets the
 * whole group led by it ({@link signalGroup}), so a pid learned some other way
 * (a CDP-reported browser pid, say) names a group the caller never spawned.
 */
export function killChromiumByPort(port: number, pid?: number): void {
  const child = liveChildren.get(port);
  if (child) {
    liveChildren.delete(port);
    killChildEscalating(child);
    return;
  }
  if (pid !== undefined) killChromiumByPidFallback(pid);
}

/** How long to wait for a killed instance to actually exit. */
const EXIT_WAIT_TIMEOUT_MS = 5000;
const EXIT_POLL_MS = 50;

/**
 * Terminate the instance on `port` and wait until the process is actually gone.
 * {@link killChromiumByPort} only delivers the signal, so an immediate reboot
 * of the same app would race the dying process's single-instance lock and the
 * replacement would quit on startup, never opening CDP. Best-effort: returns
 * after `timeoutMs` regardless. `pid` carries {@link killChromiumByPort}'s
 * group-leader requirement.
 */
export async function killChromiumByPortAndWait(
  port: number,
  pid?: number,
  timeoutMs = EXIT_WAIT_TIMEOUT_MS
): Promise<void> {
  const child = liveChildren.get(port);
  const alive = child && child.exitCode === null && child.signalCode === null;
  // Attached before the kill so an exit between the two can't be missed.
  const exited = alive ? new Promise<void>((resolve) => child.once("exit", () => resolve())) : null;

  killChromiumByPort(port, pid);

  if (exited) return Promise.race([exited, sleepUnref(timeoutMs)]);
  if (!child && pid !== undefined) {
    // No handle to await (the child exited and was evicted, or an earlier
    // tool-server booted it), so poll. The probe targets the group, not the
    // leader: the single-instance lock this wait guards is held by the browser
    // process, which can outlive the leader.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!signalGroup(pid, 0)) return;
      await sleepUnref(EXIT_POLL_MS);
    }
  }
}

/** Delay that never holds the event loop open. */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Raw-pid fallback: group SIGTERM, then group SIGKILL after a grace period.
 * Group signalling is safe because every producer ({@link bootElectronApp})
 * spawns detached, so pgid=pid names the app's own group, and necessary
 * because helpers routinely outlive the leader. The SIGKILL is gated on a
 * liveness re-probe, leaving the recycled-pgid window inherent to any raw-pid
 * signal.
 */
function killChromiumByPidFallback(pid: number): void {
  if (!signalGroup(pid, "SIGTERM")) return; // group already empty, nothing to escalate
  setTimeout(() => {
    if (signalGroup(pid, 0)) signalGroup(pid, "SIGKILL");
  }, 2000).unref();
}

/**
 * Chromium switches that keep an argent-booted app responsive while its window
 * is unfocused, occluded, or minimized. Without them the compositor throttles a
 * hidden window: mouse-input acks stall for seconds each on hit-testing, wheel
 * scrolls hang, and `document.visibilityState` flips to "hidden".
 *
 * primePageSession's focus emulation covers the same ground, but only while a
 * CDP session is attached, and sessions are created lazily and die with the
 * tool-server (which idle-exits while the app lives on) — hence flags, applied
 * unconditionally to apps we spawn. Externally launched CDP targets are
 * unaffected.
 */
const ANTI_THROTTLING_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

export async function bootElectronApp(options: BootElectronOptions): Promise<ElectronBootResult> {
  const port = options.port ?? (await pickFreePort());
  const launcher = resolveLauncher(options.appPath);
  const extra = sanitizeExtraArgs(options.extraArgs ?? []);

  const args = [
    ...launcher.args,
    `--remote-debugging-port=${port}`,
    ...ANTI_THROTTLING_ARGS,
    ...extra,
  ];

  let child: ChildProcess;
  try {
    child = spawn(launcher.command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Strip ELECTRON_RUN_AS_NODE (see electronGuiChildEnv): inherited from an
      // Electron-based MCP host it would boot the binary in Node mode with no
      // CDP endpoint, failing boot-device instead of bringing the app up.
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

  // Attach `error` before checking pid: spawn() returns synchronously but
  // ENOENT / EACCES / EAGAIN arrive as a deferred `error` event, and an
  // unhandled one crashes the whole tool-server (e.g. boot-device with
  // `electronAppPath` on a host without electron on PATH). Fold it into the
  // readiness race so the caller sees a clean rejection.
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
    // No pid and no async error yet is still possible on some platforms when
    // spawn fails very early. Detach first so an `error` event delivered after
    // this throw can't reject an orphan promise and crash the tool-server.
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

  // Forward Electron stderr so launch failures are visible to the user / agent.
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[chromium-cdp-${port}] ${chunk}`);
  });
  child.unref();

  // Race the readiness probe against the child's exit so a startup crash
  // reports "exited with code N" instead of a generic 30s readiness timeout.
  //
  // Both onExit and spawnErrorListener MUST be detached once this resolves,
  // success or failure: the child is detached + unref'd and outlives this
  // function, so a later natural exit (user closes the window) would reject the
  // orphan `earlyExit` promise and crash the tool-server.
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
    // Winning the race does not prove the app is staying up — see
    // BOOT_CONFIRM_WINDOW_MS. Confirm with the boot listeners still attached so
    // a landed or in-flight exit rejects and the catch below treats it as an
    // early exit; on a clean window detachBootListeners() nulls earlyExit's
    // reject before anything can fire it.
    await Promise.race([earlyExit, sleepUnref(BOOT_CONFIRM_WINDOW_MS)]);
  } catch (err) {
    // CDP didn't come up — terminate the orphan so we don't leak a process.
    //
    // INVARIANT: detachBootListeners() MUST be the first statement here, with
    // no awaits before it, or the boot-time listeners keep firing during
    // cleanup and reject the orphan promises.
    detachBootListeners();
    killChildEscalating(child);
    throw err;
  }
  // Detach the boot-time listeners: the child is intentionally long-lived, and
  // any later exit / error belongs to whoever manages the session next.
  detachBootListeners();

  // Retain the handle so teardown (killChromiumByPort) can kill via the
  // ChildProcess instead of a recyclable raw pid — see liveChildren. This
  // listener only clears the map entry, so a natural exit long after boot stays
  // inert; the identity check keeps a stale child's exit from evicting a newer
  // boot that reused the same fixed port.
  liveChildren.set(port, child);
  child.once("exit", () => {
    if (liveChildren.get(port) === child) liveChildren.delete(port);
  });

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
