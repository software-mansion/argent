import * as path from "node:path";
import * as http from "node:http";
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

// Compile-time bidirectional drift guard between the store's privacy-safe stat
// structs and the telemetry event props they are relayed as. `track()`'s
// excess-property check only fires on an object LITERAL; the relays below pass
// these stats as VARIABLES, so a field ADDED to a struct without extending the
// telemetry props (and sanitize()) would otherwise compile and be silently
// dropped downstream — a metric that never arrives, not a build break. This
// asserts the key sets match EXACTLY in both directions, so adding, removing, or
// renaming a field on either side fails the build here until the counterpart is
// updated too. (Field value types are still checked by the relay track() call.)
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

/**
 * Probe whether a healthy argent tool-server is already listening on
 * `host:port`. Used to tell a redundant/overlapping instance (which lost the
 * bind with EADDRINUSE) that the port is owned by a live peer, so it can defer
 * cleanly instead of crash-looping.
 *
 * An argent tool-server answers `GET /tools` with 200 (the tools JSON) or, when
 * an auth token is configured, 401 — either proves a live argent peer. No token
 * is sent: reachability + argent-shaped response is all we need. A wedged peer
 * that never answers within the timeout resolves `false`, so we still surface a
 * genuinely stuck port as a crash rather than deferring to a dead server.
 */
export function probeArgentToolServer(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: "/tools", method: "GET", timeout: timeoutMs }, (res) => {
      const isArgentPeer = res.statusCode === 200 || res.statusCode === 401;
      res.resume(); // drain the response so the socket can close
      resolve(isArgentPeer);
    });
    req.on("error", () => resolve(false)); // connection refused / reset / non-HTTP
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
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
  let shutdownReason: "idle" | "signal" | "crash" = "signal";
  let shutdownFailureSignal: FailureSignal | null = null;
  // Anonymous crash detail (class name, syscall, stack fingerprint, phase),
  // merged into the final toolserver:stop only on a real crash. Left null on
  // idle/signal stops so clean shutdowns carry no crash fields.
  let shutdownCrashDiagnostics: CrashDiagnostics | null = null;
  // Flips once the HTTP listener has bound: lets a crash record whether it hit
  // during startup (the dominant, sub-second, restart-loop population) or while
  // actually serving.
  let listening = false;
  let shutdown: ((exitCode?: number) => Promise<void>) | null = null;

  // The crash classification is passed in explicitly rather than re-derived from
  // `label`: `label` is a human-readable stderr prefix, and coupling the emitted
  // failure code to its exact wording would silently misclassify the crash if the
  // message were ever reworded.
  function crashShutdown(label: string, detail: string, signal: FailureSignal, err: unknown): void {
    process.stderr.write(`[tool-server] ${label}: ${detail}\n`);
    // A second fatal event must not re-run teardown or schedule a second timer.
    if (crashing) return;
    crashing = true;
    shutdownReason = "crash";
    finalExitCode = 1;
    shutdownFailureSignal = signal;
    // Derive the anonymous crash detail from the raw error (never from `detail`,
    // which is a human-readable stderr string). Best-effort — a failure here must
    // not stop the crash from being reported, so fall back to phase-only.
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

  // Tool events use the queued client; shutdown gets a bounded final flush.
  telemetryInit("tool_server");
  const telemetryHandle = attachRegistryTelemetry(registry);

  // Establish the telemetry identity OFF the accept path: this resolves the host
  // fingerprint asynchronously (no event-loop stall) and persists it before we
  // advertise readiness, so `toolserver:start` and every inbound request find
  // the stable id already on disk instead of a blocking spawn in the listen()
  // callback. Runs concurrently with the watcher below — never throws.
  const identityWarm = warmTelemetryIdentity();
  // The fingerprint resolve's internal timeout watchdog is unref'd (so it never
  // holds a short-lived CLI open at exit). During startup the server has no work
  // of its own yet, so hold the loop open with a ref'd handle until warm-up
  // settles — otherwise, if the binary wedged, the process could exit before
  // listen() ever binds. Self-clearing and a no-op once warm-up (usually <100ms,
  // capped at the resolve timeout) settles; makes readiness independent of any
  // incidental liveness from the watcher.
  const warmKeepAlive = setInterval(() => {}, 1_000);
  void identityWarm.finally(() => clearInterval(warmKeepAlive));
  const serverStartedAt = Date.now();
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
    // A CLI-driven Lens session (`argent lens`) keeps the window open across
    // rounds — the user iterates and their feedback is piped into the spawned
    // terminal, so a submit must never animate-close the window.
    if (variantProposalStore.isCliSession()) return;
    pendingCloseTimer = setTimeout(() => {
      pendingCloseTimer = null;
      previewWindow.requestClose();
    }, PREVIEW_CLOSE_DELAY_MS);
  };
  // `argent lens` toggles a CLI session: begin ⇒ open the window now (no await
  // needed — the agent proposes without blocking), end ⇒ close it.
  const onCliSessionChanged = (active: boolean): void => {
    cancelPendingClose();
    if (active) {
      const url = previewWindowBaseUrl();
      if (url) previewWindow.ensureOpen(url);
    } else {
      previewWindow.requestClose();
      // Tear down any simulator Lens booted itself for this session (the picker
      // "boot it first" action). Devices the user had already running were never
      // marked owned, so they're left alone. Fire-and-forget — teardown must not
      // block the session-end response.
      const owned = variantProposalStore.takeOwnedDevices();
      if (owned.length) {
        void shutdownOwnedDevices(owned).catch(() => {
          /* best-effort: a device already gone must not surface here */
        });
      }
    }
  };
  // A round the human FIRST finalized (fires once per round, never on a resubmit
  // — the store guards that). The generic tool:* path can't see this: submission
  // is an HTTP POST to /preview, not a tool call, and in a CLI Lens session the
  // await tool is hidden entirely. This is the human-decision half of the funnel.
  const onRoundCompleted = (stats: RoundCompletedStats): void => {
    telemetryTrack("lens:round_completed", stats);
  };
  // The drop-off half of the funnel: a staged round discarded before the human
  // submitted. Same rationale as roundCompleted — invisible to the generic
  // tool:* path (no tool call, no HTTP), fired from the store's reset() choke.
  const onRoundAbandoned = (stats: RoundAbandonedStats): void => {
    telemetryTrack("lens:round_abandoned", stats);
  };
  // Fired once per `argent lens` invocation (the CLI session-begin transition).
  // The generic tool:* path counts per-tool-call and lens:preview_opened counts
  // per-round, so neither can answer "how many `argent lens` runs / unique users"
  // — this per-invocation marker does. Carries only an aggregate count.
  const onCliSessionStarted = (stats: CliSessionStartedStats): void => {
    telemetryTrack("lens:cli_session_started", stats);
  };
  variantProposalStore.events.on("awaitParked", onAwaitParked);
  variantProposalStore.events.on("selectionSubmitted", onSelectionSubmitted);
  variantProposalStore.events.on("cliSessionChanged", onCliSessionChanged);
  variantProposalStore.events.on("roundCompleted", onRoundCompleted);
  variantProposalStore.events.on("roundAbandoned", onRoundAbandoned);
  variantProposalStore.events.on("cliSessionStarted", onCliSessionStarted);

  // `shutdown` closes over `server` by reference — reads the current value when
  // called, so it works correctly whether server has started yet or not.
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

    // The store-event relays (roundCompleted / roundAbandoned / …) stay attached
    // until AFTER the HTTP server closes (see the end of shutdown). The server
    // keeps accepting requests until `server.close()`, so a human clicking
    // Complete during this drain still emits `roundCompleted` — detaching the
    // relays here would silently drop it while `toolserver:stop` from this same
    // shutdown is still delivered. (A submit landing after the telemetry drain
    // below is inherently unobservable — the queue is already closing.)
    cancelPendingClose();

    // "Server died mid-review": a round still staged (proposals, unsubmitted) at
    // exit is a drop-off the funnel must see. Flush it as an abandonment now —
    // while the roundAbandoned relay is attached and BEFORE the telemetry drain
    // below — so it lands in this process's final batch instead of vanishing into
    // the unattributable opens-minus-completions residue. A completed or empty
    // round is a no-op (guarded inside flushAbandonedRound). On a clean CLI end
    // the session-boundary reset already swept the round, so this is a no-op too.
    variantProposalStore.flushAbandonedRound();

    // Drain any simulators Lens booted headless for a CLI session. The happy
    // path drains via onCliSessionChanged(false) when the CLI ends the session,
    // but a server-initiated exit (signal, idle timeout) never gets that POST —
    // without this the headless sim (no GUI window) is left Booted and orphaned.
    // Idempotent: takeOwnedDevices drains the set once, so it's [] here if the
    // CLI already ended cleanly.
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

    // Tear the registry down BEFORE recording toolserver:stop. A crash that
    // escalates mid-shutdown (crashShutdown sets shutdownReason="crash" plus a
    // failure signal, then re-enters here and the guard short-circuits it) would
    // otherwise be lost behind an already-sent reason:"signal" stop event — the
    // exit code escalates via finalExitCode but the telemetry didn't. Recording
    // the stop event last means it reflects everything up to this point.
    // Guarded so a dispose failure can't skip the stop event itself.
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

    // Capture toolserver:stop, then drain — the final telemetry action, so the
    // reason/signal are as fresh as possible. (A crash during the drain below is
    // inherently unobservable: the queue is already closing.)
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
    // Detach the store-event relays now that the server is closed (no more
    // requests can emit). Kept until here so a submit during the drain above was
    // still relayed; removing them matters for a repeated in-process start()
    // (tests) since the store is a module singleton that outlives one server.
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
        duration_ms: durationMs,
        ...signal,
        ...aiTelemetryFromMeta(meta),
      });
    },
  });

  // Block advertising readiness until the first watcher poll completes — this
  // guarantees DYLD_INSERT_LIBRARIES is set in launchd for all currently-booted
  // simulators before any agent tool call (e.g. launch-app) can arrive. Also
  // wait for the identity warm-up (started above, runs concurrently) so the
  // fingerprint resolve is done before the accept path opens, never on it.
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
        // Report start only after the HTTP listener actually binds.
        try {
          telemetryTrack("toolserver:start", {});
        } catch {
          /* swallow */
        }
      });
      // Bind failure handling. EACCES (privileged port) and other errors are
      // genuine faults → crashShutdown, which captures `err.code` as
      // error_syscall on a reason:"crash" stop and handles teardown + telemetry
      // drain + exit.
      //
      // EADDRINUSE is special: it means another server already owns HOST:PORT.
      // Unconditionally crashing feeds a supervisor respawn → re-bind → crash
      // loop — the 0.16.0 crash telemetry's `toolserver_bind` population (one
      // machine alone: 785 crashes, ~1s uptime, 0 tool calls served, never
      // serving anything). If a healthy argent tool-server already answers on
      // the port, this instance is redundant, so shut down cleanly (exit 0) and
      // defer to the existing one instead of looping. Only when nothing healthy
      // owns the port (a foreign holder, or a wedged peer) do we still crash, so
      // a genuinely stuck port stays visible.
      const bindSignal: FailureSignal = {
        error_code: FAILURE_CODES.ARGENT_UNCLASSIFIED_FAILURE,
        failure_stage: "toolserver_bind",
        failure_area: "tool_server",
        error_kind: "crash",
      };
      server.on("error", (err: NodeJS.ErrnoException) => {
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
        const code = err.code ? `${err.code}: ` : "";
        const crashBind = () =>
          crashShutdown(`Failed to bind ${HOST}:${PORT}`, `${code}${err.message}`, bindSignal, err);

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
            // Clean stop (not a crash): removes this redundant instance from the
            // reason:"crash" restart-loop population.
            void shutdown?.(0);
          });
          return;
        }
        crashBind();
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
        // The readiness gate rejected before the HTTP listener bound, so this is
        // definitionally a startup crash — attach the anonymous diagnostics from
        // `err` (phase + name/fingerprint) so it clusters instead of collapsing
        // back into the opaque bucket. Best-effort — a diagnostics failure must
        // never stop the crash from being reported, so fall back to phase-only.
        try {
          shutdownCrashDiagnostics = describeCrash(err, "startup");
        } catch {
          shutdownCrashDiagnostics = { crash_phase: "startup" };
        }
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
