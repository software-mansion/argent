import * as path from "node:path";
import { homedir } from "node:os";
import { isFlagEnabled } from "@argent/configuration-core";
import { FAILURE_CODES, attachRegistryLogger, type FailureSignal } from "@argent/registry";
import {
  init as telemetryInit,
  attachRegistryTelemetry,
  track as telemetryTrack,
  shutdown as telemetryShutdown,
  warmTelemetryIdentity,
  aiTelemetryFromMeta,
  describeCrash,
  type CrashDiagnostics,
  type EventPropertyMap,
} from "@argent/telemetry";
import { createHttpApp } from "./http";
import { attachRegistryEventLogger, createToolServerEventLog } from "./event-log";
import { createRegistry } from "./utils/setup-registry";
import { probeArgentToolServer } from "./utils/probe-argent-tool-server";
import { startSimulatorWatcher } from "./utils/simulator-watcher";
import { startUpdateChecker } from "./utils/update-checker";
import { createPreviewWindowManager } from "./utils/preview-window";
import {
  variantProposalStore,
  type RoundCompletedStats,
  type RoundAbandonedStats,
  type CliSessionStartedStats,
} from "./utils/variant-proposals";
import { shutdownOwnedDevices } from "./utils/device-shutdown";

const PROCESS_TIMEOUT_MS = 5_000;
const DEFAULT_PORT = "3001";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_IDLE_TIMEOUT_MINUTES = "0";

// The relays below pass these stats as variables, so `track()`'s excess-property
// check (object literals only) cannot catch drift: a field added to a struct but
// not to the telemetry props would compile and be silently dropped. Asserting the
// key sets match in both directions turns that into a build break.
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : never
  : never;
const _lensStatDriftGuards: [
  SameKeys<RoundCompletedStats, EventPropertyMap["lens:round_completed"]>,
  SameKeys<RoundAbandonedStats, EventPropertyMap["lens:round_abandoned"]>,
  SameKeys<CliSessionStartedStats, EventPropertyMap["lens:cli_session_started"]>,
] = [true, true, true];
void _lensStatDriftGuards;

// Bracket IPv6 literals per RFC 3986 §3.2.2.
function formatOrigin(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

// Delay before asking the preview window to close after a submit, so the
// renderer can show its "Selection sent" toast. Purely cosmetic — the agent's
// await has already resolved.
const PREVIEW_CLOSE_DELAY_MS = 1_000;

/**
 * Prepends an ISO timestamp to everything written to stdout/stderr.
 *
 * Patches `stream.write` rather than `console.*` because this server writes to
 * `process.stdout` / `process.stderr` directly. Set WRAP_STDIO_DISABLED to opt
 * out.
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

  // Exit on uncaught errors (state may be corrupted), but clean up first so
  // child processes are not orphaned.
  let shuttingDown = false;
  let crashing = false;
  // shutdown() exits with this, read at the actual process.exit — not with the
  // argument it was first invoked with. Lets a crash overlapping an in-flight
  // shutdown(0) still exit 1 despite the re-entrancy guard.
  let finalExitCode = 0;
  let shutdownReason: "idle" | "signal" | "crash" | "deferred" = "signal";
  let shutdownFailureSignal: FailureSignal | null = null;
  // Merged into the final toolserver:stop only on a real crash; left null on
  // idle/signal stops so clean shutdowns carry no crash fields.
  let shutdownCrashDiagnostics: CrashDiagnostics | null = null;
  // Lets a crash record whether it hit during startup or while serving.
  let listening = false;
  let shutdown: ((exitCode?: number) => Promise<void>) | null = null;

  // `signal` is passed in rather than derived from `label`: `label` is a
  // human-readable stderr prefix, and rewording it must not reclassify the crash.
  function crashShutdown(label: string, detail: string, signal: FailureSignal, err: unknown): void {
    process.stderr.write(`[tool-server] ${label}: ${detail}\n`);
    // A second fatal event must not re-run teardown or schedule a second timer.
    if (crashing) return;
    crashing = true;
    shutdownReason = "crash";
    finalExitCode = 1;
    shutdownFailureSignal = signal;
    // From the raw error, not `detail` (a display string). Best-effort: a failure
    // here must not stop the crash being reported, so fall back to phase-only.
    try {
      shutdownCrashDiagnostics = describeCrash(err, listening ? "serving" : "startup");
    } catch {
      shutdownCrashDiagnostics = { crash_phase: listening ? "serving" : "startup" };
    }
    setTimeout(() => process.exit(1), PROCESS_TIMEOUT_MS);
    if (shutdown) {
      shutdown(1).catch(() => process.exit(1));
    } else {
      process.exit(1);
    }
  }

  process.on("uncaughtException", (err) => {
    crashShutdown(
      "Uncaught exception",
      String(err.stack ?? err),
      {
        error_code: FAILURE_CODES.TOOLSERVER_UNCAUGHT_EXCEPTION,
        failure_stage: "toolserver_uncaught_exception",
        failure_area: "tool_server",
        error_kind: "crash",
      },
      err
    );
  });
  process.on("unhandledRejection", (reason) => {
    crashShutdown(
      "Unhandled rejection",
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
      {
        error_code: FAILURE_CODES.TOOLSERVER_UNHANDLED_REJECTION,
        failure_stage: "toolserver_unhandled_rejection",
        failure_area: "tool_server",
        error_kind: "crash",
      },
      reason
    );
  });

  const PORT = parseInt(process.env.ARGENT_PORT ?? DEFAULT_PORT, 10);
  const HOST = process.env.ARGENT_HOST ?? DEFAULT_HOST;
  const idleMinutes = parseInt(
    process.env.ARGENT_IDLE_TIMEOUT_MINUTES ?? DEFAULT_IDLE_TIMEOUT_MINUTES,
    10
  );
  const idleTimeoutMs = idleMinutes > 0 ? idleMinutes * 60_000 : 0;

  const registry = createRegistry();
  attachRegistryLogger(registry);
  let eventLog: ReturnType<typeof createToolServerEventLog> | null = null;
  if (isFlagEnabled("tool-server-event-log")) {
    const eventLogPath =
      process.env.ARGENT_EVENT_LOG || path.join(homedir(), ".argent", "tool-server-events.jsonl");
    try {
      eventLog = createToolServerEventLog({ filePath: eventLogPath });
    } catch (err) {
      process.stderr.write(
        `[tool-server] Failed to create event log at ${eventLogPath}: ${String(err)}\n`
      );
    }
  }
  if (eventLog) {
    attachRegistryEventLogger(registry, eventLog);
  }
  if (eventLog) {
    process.stderr.write(`[tool-server] Event log: ${eventLog.filePath}\n`);
  }

  telemetryInit("tool_server");
  const telemetryHandle = attachRegistryTelemetry(registry);

  // Resolve and persist the host fingerprint before readiness is advertised, so
  // no inbound request pays a blocking spawn for it. Never throws.
  const identityWarm = warmTelemetryIdentity();
  // The fingerprint resolve unrefs its own handles and startup has no other work
  // pending, so without a ref'd handle a wedged resolve could let the process exit
  // before listen() ever binds.
  const warmKeepAlive = setInterval(() => {}, 1_000);
  void identityWarm.finally(() => clearInterval(warmKeepAlive));
  const serverStartedAt = Date.now();
  const updateChecker = startUpdateChecker();

  const { stop: stopWatcher, ready: watcherReady } = startSimulatorWatcher(registry);

  let server: ReturnType<typeof httpHandle.app.listen> | null = null;

  // Spawned on demand when an `await_user_selection` parks, closed when the user
  // submits; the same child is reused across rounds.
  const previewWindow = createPreviewWindowManager({
    // Electron is an optionalDependency (absent on headless/CI hosts); on a launch
    // failure unblock any parked await with the browser fallback URL rather than
    // stranding it for the full timeout. `previewWindowBaseUrl` is declared below
    // but only called at runtime.
    onLaunchFailure: (err) =>
      variantProposalStore.notifyWindowUnavailable(err.message, previewWindowBaseUrl()),
  });
  const previewWindowBaseUrl = (): string | null => {
    if (!server) return null;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : null;
    if (!port) return null;
    // Pass the device the agent proposed against so the window connects directly
    // instead of asking the user to pick one.
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
    // A round parking within PREVIEW_CLOSE_DELAY_MS of a submit would otherwise
    // have the pending close snatch its freshly opened window away.
    cancelPendingClose();
    const url = previewWindowBaseUrl();
    if (url) previewWindow.ensureOpen(url);
  };
  const onSelectionSubmitted = (): void => {
    cancelPendingClose();
    // `argent lens` keeps one window open across rounds while the user iterates,
    // so a submit must not close it.
    if (variantProposalStore.isCliSession()) return;
    pendingCloseTimer = setTimeout(() => {
      pendingCloseTimer = null;
      previewWindow.requestClose();
    }, PREVIEW_CLOSE_DELAY_MS);
  };
  // In a CLI session the window opens on session begin, not on a parked await —
  // the agent proposes without blocking.
  const onCliSessionChanged = (active: boolean): void => {
    cancelPendingClose();
    if (active) {
      const url = previewWindowBaseUrl();
      if (url) previewWindow.ensureOpen(url);
    } else {
      previewWindow.requestClose();
      // Only simulators Lens booted itself (the picker's "boot it first" action)
      // are marked owned; devices the user already had running are left alone.
      // Fire-and-forget so teardown cannot block the session-end response.
      const owned = variantProposalStore.takeOwnedDevices();
      if (owned.length) {
        void shutdownOwnedDevices(owned).catch(() => {
          /* best-effort: a device already gone must not surface here */
        });
      }
    }
  };
  // The human-decision half of the Lens funnel. The generic tool:* path cannot see
  // it: a submit is an HTTP POST to /preview, not a tool call. Fires once per
  // round — the store suppresses resubmits.
  const onRoundCompleted = (stats: RoundCompletedStats): void => {
    telemetryTrack("lens:round_completed", stats);
  };
  // The drop-off half: a staged round discarded before the human submitted, fired
  // from the store's reset() choke point. Also invisible to the tool:* path.
  const onRoundAbandoned = (stats: RoundAbandonedStats): void => {
    telemetryTrack("lens:round_abandoned", stats);
  };
  // Once per `argent lens` invocation. tool:* counts per tool call and
  // lens:preview_opened per round, so neither can count runs or unique users.
  const onCliSessionStarted = (stats: CliSessionStartedStats): void => {
    telemetryTrack("lens:cli_session_started", stats);
  };
  variantProposalStore.events.on("awaitParked", onAwaitParked);
  variantProposalStore.events.on("selectionSubmitted", onSelectionSubmitted);
  variantProposalStore.events.on("cliSessionChanged", onCliSessionChanged);
  variantProposalStore.events.on("roundCompleted", onRoundCompleted);
  variantProposalStore.events.on("roundAbandoned", onRoundAbandoned);
  variantProposalStore.events.on("cliSessionStarted", onCliSessionStarted);

  shutdown = async (exitCode = 0) => {
    // Escalate before the re-entrancy guard can short-circuit a later,
    // higher-severity call (e.g. a crash overlapping a graceful shutdown).
    if (exitCode > finalExitCode) finalExitCode = exitCode;
    if (shuttingDown) return;
    shuttingDown = true;

    eventLog?.info({
      type: "tool_server.stopping",
      msg: "Tool server is stopping.",
      exitCode: finalExitCode,
    });

    // The store-event relays stay attached until after `server.close()` at the end
    // of shutdown: requests are still accepted until then, so a human submitting
    // during the drain is still counted.
    cancelPendingClose();

    // A round still staged at exit is a drop-off the funnel must see. Flush it
    // here — relays still attached, before the telemetry drain — so it lands in
    // this process's final batch. No-op for a completed or empty round.
    variantProposalStore.flushAbandonedRound();

    // A server-initiated exit (signal, idle timeout) never gets the CLI's
    // session-end POST, so simulators Lens booted itself would be left Booted.
    // takeOwnedDevices drains once, so this is empty after a clean CLI end.
    const ownedDevices = variantProposalStore.takeOwnedDevices();
    if (ownedDevices.length) {
      await shutdownOwnedDevices(ownedDevices).catch(() => {
        /* best-effort: a device already gone must not block shutdown */
      });
    }

    previewWindow.dispose();
    updateChecker.dispose();
    stopWatcher();
    httpHandle.dispose();

    // Dispose BEFORE recording toolserver:stop, so a crash escalating mid-teardown
    // is reflected in the stop event's reason instead of being lost behind an
    // already-sent reason:"signal". Guarded so a dispose failure cannot skip it.
    try {
      await registry.dispose();
    } catch (err) {
      process.stderr.write(`[tool-server] registry dispose failed: ${String(err)}\n`);
    }
    try {
      await eventLog?.dispose();
    } catch (err) {
      process.stderr.write(`[tool-server] event log dispose failed: ${String(err)}\n`);
    }

    // Last telemetry action, so reason/signal are as fresh as possible; a crash
    // during the drain itself is unobservable.
    try {
      telemetryTrack("toolserver:stop", {
        reason: shutdownReason,
        uptime_ms: Date.now() - serverStartedAt,
        total_tool_calls: telemetryHandle.getTotalToolCalls(),
        ...(shutdownFailureSignal ?? {}),
        ...(shutdownCrashDiagnostics ?? {}),
      });
      telemetryHandle.detach();
      await telemetryShutdown(1500);
    } catch {
      // Telemetry must never block process exit.
    }

    if (server) {
      const forceExit = setTimeout(() => process.exit(finalExitCode), PROCESS_TIMEOUT_MS);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      clearTimeout(forceExit);
    }
    // The store is a module singleton outliving one server, so a repeated
    // in-process start() (tests) would otherwise stack duplicate relays.
    variantProposalStore.events.off("awaitParked", onAwaitParked);
    variantProposalStore.events.off("selectionSubmitted", onSelectionSubmitted);
    variantProposalStore.events.off("cliSessionChanged", onCliSessionChanged);
    variantProposalStore.events.off("roundCompleted", onRoundCompleted);
    variantProposalStore.events.off("roundAbandoned", onRoundAbandoned);
    variantProposalStore.events.off("cliSessionStarted", onCliSessionStarted);
    process.exit(finalExitCode);
  };

  const httpHandle = createHttpApp(registry, {
    idleTimeoutMs,
    onIdle: () => {
      shutdownReason = "idle";
      void shutdown?.();
    },
    onShutdown: shutdown,
    bindHost: HOST,
    recordInvocation: telemetryHandle.recordInvocation,
    recordFailure: (toolId, meta, signal, durationMs) => {
      telemetryTrack("tool:fail", {
        tool: toolId,
        ...(meta.platform ? { platform: meta.platform } : {}),
        ...(meta.invalid_params?.length ? { invalid_params: meta.invalid_params } : {}),
        duration_ms: durationMs,
        ...signal,
        ...aiTelemetryFromMeta(meta),
      });
    },
  });

  // Do not bind until the first watcher poll has attempted dylib injection for
  // every booted simulator (so launch-app cannot race it) and the identity
  // warm-up has settled (so the accept path never pays for it).
  Promise.all([watcherReady, identityWarm])
    .then(() => {
      server = httpHandle.app.listen(PORT, HOST, () => {
        // Past this point a crash is a serving-time fault, not a startup fault.
        listening = true;
        const addr = server!.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : PORT;
        const origin = formatOrigin(HOST, boundPort);
        process.stdout.write(`Tools server listening on ${origin}\n`);
        process.stderr.write(`  GET  ${origin}/tools\n`);
        process.stderr.write(`  POST ${origin}/tools/:name\n`);
        eventLog?.info({
          type: "tool_server.started",
          msg: `Tool server started on ${origin}.`,
          origin,
          host: HOST,
          port: boundPort,
        });
        if (idleTimeoutMs > 0) {
          process.stderr.write(`  Idle timeout: ${idleMinutes}min\n`);
        }
        try {
          telemetryTrack("toolserver:start", {});
        } catch {
          /* swallow */
        }
      });
      // EADDRINUSE means another server owns HOST:PORT; crashing on it feeds a
      // supervisor respawn → re-bind → crash loop (a real 0.16.0 restart-loop
      // population). If a healthy argent peer answers there, this instance is
      // redundant: exit 0 and defer to it. A foreign or wedged holder still
      // crashes, so a genuinely stuck port stays visible. Every other bind error
      // is a genuine fault → crashShutdown.
      const bindSignal: FailureSignal = {
        error_code: FAILURE_CODES.ARGENT_UNCLASSIFIED_FAILURE,
        failure_stage: "toolserver_bind",
        failure_area: "tool_server",
        error_kind: "crash",
      };
      server.on("error", (err: NodeJS.ErrnoException) => {
        const code = err.code ? `${err.code}: ` : "";
        // Only the legs that actually crash log bind_failed — a clean deferral is
        // no more a bind crash in the event log than in the stop-reason telemetry.
        const crashBind = () => {
          eventLog?.error({
            type: "tool_server.bind_failed",
            msg: `Tool server failed to bind ${HOST}:${PORT}.`,
            host: HOST,
            port: PORT,
            failureSignal: {
              error_code: bindSignal.error_code,
              failure_stage: bindSignal.failure_stage,
              failure_area: bindSignal.failure_area,
              error_kind: bindSignal.error_kind,
            },
          });
          crashShutdown(`Failed to bind ${HOST}:${PORT}`, `${code}${err.message}`, bindSignal, err);
        };

        if (err.code === "EADDRINUSE") {
          void probeArgentToolServer(HOST, PORT).then((isArgentPeer) => {
            if (!isArgentPeer) {
              crashBind();
              return;
            }
            process.stderr.write(
              `Another argent tool-server already owns ${HOST}:${PORT}; deferring to it (redundant instance).\n`
            );
            eventLog?.info({
              type: "tool_server.deferred_to_existing",
              msg: `Deferred to an existing tool-server on ${HOST}:${PORT}.`,
              host: HOST,
              port: PORT,
            });
            // Stamped "deferred" rather than the default "signal" so a supervisor
            // relaunching on any exit shows up as a deferral loop instead of
            // blending into ordinary SIGINT/SIGTERM churn.
            shutdownReason = "deferred";
            void shutdown?.(0);
          });
          return;
        }
        crashBind();
      });
      // Needs the http.Server, which only exists once `listen()` has been called.
      // One attach covers every device — the handler routes upgrades by URL.
      httpHandle.attachChromiumWebsockets(server);
    })
    .catch((err) => {
      void (async () => {
        process.stderr.write(
          `[tool-server] Failed to start: ${err instanceof Error ? err.message : err}\n`
        );
        eventLog?.error({
          type: "tool_server.start_failed",
          msg: "Tool server failed to start.",
          failureSignal: {
            error_code: FAILURE_CODES.ARGENT_UNCLASSIFIED_FAILURE,
            failure_stage: "toolserver_start",
            failure_area: "tool_server",
            error_kind: "unknown",
          },
        });
        shutdownReason = "crash";
        // The readiness gate rejected before the listener bound, so this is always
        // a startup crash. Best-effort: fall back to phase-only if describeCrash
        // itself throws.
        try {
          shutdownCrashDiagnostics = describeCrash(err, "startup");
        } catch {
          shutdownCrashDiagnostics = { crash_phase: "startup" };
        }
        await shutdown?.(1);
      })();
    });

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());

  // A parent that stops reading its end of the pipe (e.g. the MCP launcher, once
  // it has captured the startup line) turns every later write into EPIPE.
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

// process.exit() does not drain a piped WriteStream's buffer, so exit from the
// write callback instead.
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
