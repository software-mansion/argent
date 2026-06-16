import { attachRegistryLogger } from "@argent/registry";
import {
  init as telemetryInit,
  attachRegistryTelemetry,
  track as telemetryTrack,
  shutdown as telemetryShutdown,
} from "@argent/telemetry";
import { createHttpApp } from "./http";
import { createRegistry } from "./utils/setup-registry";
import { startSimulatorWatcher } from "./utils/simulator-watcher";
import { startUpdateChecker } from "./utils/update-checker";
import { createPreviewWindowManager } from "./utils/preview-window";
import { variantProposalStore } from "./utils/variant-proposals";

const PROCESS_TIMEOUT_MS = 5_000;
const DEFAULT_PORT = "3001";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_IDLE_TIMEOUT_MINUTES = "0";

// Format an HTTP origin for display. Bracket IPv6 literals per RFC 3986 §3.2.2.
function formatOrigin(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

// After a successful selection submit, wait this long before asking the
// Electron preview window to play its close animation. Gives the renderer
// time to show the green "Selection sent" toast first; the agent's await
// has already been resolved by this point, so the delay is purely cosmetic.
const PREVIEW_CLOSE_DELAY_MS = 1_000;

/**
 * Prepends an ISO timestamp to every line written to stdout/stderr.
 *
 * We replace `stream.write` rather than wrapping `console.*` because the MCP
 * transport and other internal paths bypass `console` and call `process.stdout`
 * / `process.stderr` directly.
 *
 * The override is safe: we call the original bound `write` with the modified
 * chunk and forward all remaining arguments unchanged.
 *
 * Set WRAP_STDIO_DISABLED=1 in the environment to opt out (diagnosis mainly)
 */
function initializeStdioTimestampWrapper(): void {
  if (process.env.WRAP_STDIO_DISABLED) return;

  for (const stream of [process.stdout, process.stderr] as const) {
    const orig = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
      orig(`[${new Date().toISOString()}] ${chunk}`, ...(rest as []))) as typeof stream.write;
  }
}

export function start(): void {
  initializeStdioTimestampWrapper();

  // ── Global error handlers ─────────────────────────────────────────
  // The tool server should exit on uncaught errors (state may be corrupted),
  // but attempt graceful cleanup first so child processes are not orphaned.
  let shuttingDown = false;
  let crashing = false;
  // Module-scoped so a crash that overlaps an in-flight graceful shutdown can
  // escalate it: shutdown() exits with finalExitCode (read at the actual
  // process.exit), not the argument it was first invoked with. Without this a
  // crash arriving mid-shutdown would be swallowed by the re-entrancy guard and
  // the in-flight shutdown(0) would exit 0, hiding the crash from supervisors.
  let finalExitCode = 0;
  let shutdown: ((exitCode?: number) => Promise<void>) | null = null;

  function crashShutdown(label: string, detail: string): void {
    process.stderr.write(`[tool-server] ${label}: ${detail}\n`);
    // A second fatal event must not re-run teardown or schedule a second timer.
    if (crashing) return;
    crashing = true;
    shutdownReason = "crash";
    finalExitCode = 1;
    setTimeout(() => process.exit(1), PROCESS_TIMEOUT_MS);
    if (shutdown) {
      shutdown(1).catch(() => process.exit(1));
    } else {
      process.exit(1);
    }
  }

  process.on("uncaughtException", (err) => {
    crashShutdown("Uncaught exception", String(err.stack ?? err));
  });
  process.on("unhandledRejection", (reason) => {
    crashShutdown(
      "Unhandled rejection",
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    );
  });

  // ── Config ────────────────────────────────────────────────────────
  const PORT = parseInt(process.env.ARGENT_PORT ?? DEFAULT_PORT, 10);
  const HOST = process.env.ARGENT_HOST ?? DEFAULT_HOST;
  const idleMinutes = parseInt(
    process.env.ARGENT_IDLE_TIMEOUT_MINUTES ?? DEFAULT_IDLE_TIMEOUT_MINUTES,
    10
  );
  const idleTimeoutMs = idleMinutes > 0 ? idleMinutes * 60_000 : 0;

  // ── Bootstrap ─────────────────────────────────────────────────────
  const registry = createRegistry();
  attachRegistryLogger(registry);

  // Tool events use the queued client; shutdown gets a bounded final flush.
  telemetryInit("tool_server");
  const telemetryHandle = attachRegistryTelemetry(registry);
  const serverStartedAt = Date.now();
  let shutdownReason: "idle" | "signal" | "crash" = "signal";

  const updateChecker = startUpdateChecker();

  const { stop: stopWatcher, ready: watcherReady } = startSimulatorWatcher(registry);

  let server: ReturnType<typeof httpHandle.app.listen> | null = null;

  // The Electron preview window is spawned on demand when an
  // `await_user_selection` parks, and asked to animate-close itself when the
  // user submits. The same child is reused across rounds within one
  // tool-server lifetime.
  const previewWindow = createPreviewWindowManager({
    // If Electron can't launch (it's an optionalDependency — absent on
    // headless/CI hosts), fail fast: unblock any parked await_user_selection
    // with the browser fallback URL instead of stranding it for the full
    // timeout. `previewWindowBaseUrl` (declared just below) is only read when
    // this fires at runtime, long after module init.
    onLaunchFailure: (err) =>
      variantProposalStore.notifyWindowUnavailable(err.message, previewWindowBaseUrl()),
  });
  const previewWindowBaseUrl = (): string | null => {
    if (!server) return null;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : null;
    if (!port) return null;
    // Stream the device the agent proposed against (if any), so the window
    // connects directly instead of asking the user to pick a simulator.
    const device = variantProposalStore.snapshot().device;
    const query = device ? `?udid=${encodeURIComponent(device)}` : "";
    return `http://127.0.0.1:${port}/preview/${query}`;
  };
  let pendingCloseTimer: NodeJS.Timeout | null = null;
  const cancelPendingClose = (): void => {
    if (pendingCloseTimer) {
      clearTimeout(pendingCloseTimer);
      pendingCloseTimer = null;
    }
  };
  const onAwaitParked = (): void => {
    // If a fresh round parks within PREVIEW_CLOSE_DELAY_MS of a submit,
    // the pending close would fire seconds after the new window opened
    // and squeeze it away under the user. Cancel the close instead.
    cancelPendingClose();
    const url = previewWindowBaseUrl();
    if (url) previewWindow.ensureOpen(url);
  };
  const onSelectionSubmitted = (): void => {
    cancelPendingClose();
    pendingCloseTimer = setTimeout(() => {
      pendingCloseTimer = null;
      previewWindow.requestClose();
    }, PREVIEW_CLOSE_DELAY_MS);
  };
  // User clicked "Close" in the preview window — dismiss it immediately (the
  // animated close), leaving any parked await still waiting.
  const onCloseRequested = (): void => {
    cancelPendingClose();
    previewWindow.requestClose();
  };
  variantProposalStore.events.on("awaitParked", onAwaitParked);
  variantProposalStore.events.on("selectionSubmitted", onSelectionSubmitted);
  variantProposalStore.events.on("closeRequested", onCloseRequested);

  // `shutdown` closes over `server` by reference — reads the current value when
  // called, so it works correctly whether server has started yet or not.
  shutdown = async (exitCode = 0) => {
    // Escalate before the re-entrancy guard can short-circuit a later,
    // higher-severity call (e.g. a crash overlapping a graceful shutdown).
    if (exitCode > finalExitCode) finalExitCode = exitCode;
    if (shuttingDown) return;
    shuttingDown = true;

    variantProposalStore.events.off("awaitParked", onAwaitParked);
    variantProposalStore.events.off("selectionSubmitted", onSelectionSubmitted);
    variantProposalStore.events.off("closeRequested", onCloseRequested);
    cancelPendingClose();
    previewWindow.dispose();
    updateChecker.dispose();
    stopWatcher();
    httpHandle.dispose();

    // Emit toolserver:stop before tearing the registry down.
    try {
      telemetryTrack("toolserver:stop", {
        reason: shutdownReason,
        uptime_ms: Date.now() - serverStartedAt,
        total_tool_calls: telemetryHandle.getTotalToolCalls(),
      });
      telemetryHandle.detach();
      await telemetryShutdown(1500);
    } catch {
      // Telemetry must never block process exit.
    }

    await registry.dispose();
    if (server) {
      const forceExit = setTimeout(() => process.exit(finalExitCode), PROCESS_TIMEOUT_MS);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      clearTimeout(forceExit);
    }
    process.exit(finalExitCode);
  };

  const httpHandle = createHttpApp(registry, {
    idleTimeoutMs,
    onIdle: () => {
      shutdownReason = "idle";
      shutdown?.();
    },
    onShutdown: shutdown,
    bindHost: HOST,
    recordInvocation: telemetryHandle.recordInvocation,
  });

  // Block advertising readiness until the first watcher poll completes — this
  // guarantees DYLD_INSERT_LIBRARIES is set in launchd for all currently-booted
  // simulators before any agent tool call (e.g. launch-app) can arrive.
  watcherReady
    .then(() => {
      server = httpHandle.app.listen(PORT, HOST, () => {
        const addr = server!.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : PORT;
        const origin = formatOrigin(HOST, boundPort);
        process.stdout.write(`Tools server listening on ${origin}\n`);
        process.stderr.write(`  GET  ${origin}/tools\n`);
        process.stderr.write(`  POST ${origin}/tools/:name\n`);
        if (idleTimeoutMs > 0) {
          process.stderr.write(`  Idle timeout: ${idleMinutes}min\n`);
        }
        // Report start only after the HTTP listener actually binds.
        try {
          telemetryTrack("toolserver:start", {});
        } catch {
          /* swallow */
        }
      });
      // Surface bind failures (EADDRINUSE / EACCES on privileged ports) as a
      // clean exit instead of routing through uncaughtException → crashShutdown.
      server.on("error", (err: NodeJS.ErrnoException) => {
        const code = err.code ? `${err.code}: ` : "";
        process.stderr.write(
          `[tool-server] Failed to bind ${HOST}:${PORT} — ${code}${err.message}\n`
        );
        process.exit(1);
      });
      // Bolt the per-Chromium-device WebSocket upgrade handler onto the live
      // server. Must happen AFTER `listen()` so the http.Server instance
      // exists; the handler is process-wide so attaching once is enough.
      httpHandle.attachChromiumWebsockets(server);
    })
    .catch((err) => {
      void (async () => {
        process.stderr.write(
          `[tool-server] Failed to start: ${err instanceof Error ? err.message : err}\n`
        );
        shutdownReason = "crash";
        await shutdown?.(1);
      })();
    });

  // ── Lifecycle ─────────────────────────────────────────────────────
  // `process.on` passes "SIGINT" as the first arg. Passing it would cause a TypeError crash. Using `() =>` ignores it.
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());

  // When stdout is piped to a parent that stops reading (e.g. the MCP launcher
  // after it captures the startup line), writes via console.log emit EPIPE.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") {
      process.stderr.write(`[tool-server] stdout error: ${err.message}\n`);
    }
  });
  process.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") {
      try {
        process.stdout.write(`[tool-server] stderr error: ${err.message}\n`);
      } catch {
        /* both streams broken */
      }
    }
  });
}

export function getAvailableTools(): Array<{
  id: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}> {
  const registry = createRegistry();
  return registry.getSnapshot().tools.map((id) => {
    const def = registry.getTool(id)!;
    return { id: def.id, description: def.description, inputSchema: def.inputSchema };
  });
}

function usageText(): string {
  return (
    "Usage: tool-server <command>\n\n" +
    "Commands:\n" +
    "  start                        Start the tool server\n" +
    "  -t, --get-available-tools    Print available tools as JSON and exit\n" +
    "  -h, --help                   Show this menu\n"
  );
}

// process.exit() does not drain Node's WriteStream buffer when stdout/stderr
// is a pipe, so large writes must be flushed via the write callback before
// exiting.
function writeAndExit(stream: NodeJS.WriteStream, chunk: string, code: number): void {
  stream.write(chunk, () => process.exit(code));
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "start") {
    start();
  } else if (cmd === "-t" || cmd === "--get-available-tools") {
    writeAndExit(process.stdout, JSON.stringify(getAvailableTools(), null, 2) + "\n", 0);
  } else if (cmd === "-h" || cmd === "--help") {
    writeAndExit(process.stdout, usageText(), 0);
  } else {
    const prefix = cmd ? `Unknown command: ${cmd}\n\n` : "";
    writeAndExit(process.stderr, prefix + usageText(), 1);
  }
}
