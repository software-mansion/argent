import { attachRegistryLogger } from "@argent/registry";
import { createHttpApp } from "./http";
import { createRegistry } from "./utils/setup-registry";
import { startSimulatorWatcher } from "./utils/simulator-watcher";
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from "./utils/idle-timer";
import { startUpdateChecker } from "./utils/update-checker";

const PROCESS_TIMEOUT_MS = 5_000;

// Format an HTTP origin for display. Bracket IPv6 literals per RFC 3986 §3.2.2.
function formatOrigin(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

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
  let shutdown: ((exitCode?: number) => Promise<void>) | null = null;

  function crashShutdown(label: string, detail: string): void {
    process.stderr.write(`[tool-server] ${label}: ${detail}\n`);
    if (shuttingDown) return; // avoid re-entrant shutdown
    shuttingDown = true;
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
  const PORT = parseInt(process.env.ARGENT_PORT ?? "3001", 10);
  // ARGENT_HOST defaults to loopback so the local auto-spawn path stays safe.
  // `argent server start --host 0.0.0.0` is the opt-in for remote exposure.
  const HOST = process.env.ARGENT_HOST ?? "127.0.0.1";
  const idleMinutes = parseInt(
    process.env.ARGENT_IDLE_TIMEOUT_MINUTES ?? String(DEFAULT_IDLE_TIMEOUT_MINUTES),
    10
  );
  const idleTimeoutMs = idleMinutes > 0 ? idleMinutes * 60_000 : 0;

  // ── Bootstrap ─────────────────────────────────────────────────────
  const registry = createRegistry();
  attachRegistryLogger(registry);
  const updateChecker = startUpdateChecker();

  const { stop: stopWatcher, ready: watcherReady } = startSimulatorWatcher(registry);

  let server: ReturnType<typeof httpHandle.app.listen> | null = null;

  // `shutdown` closes over `server` by reference — reads the current value when
  // called, so it works correctly whether server has started yet or not.
  shutdown = async (exitCode = 0) => {
    updateChecker.dispose();
    stopWatcher();
    httpHandle.dispose();
    await registry.dispose();
    if (server) {
      const forceExit = setTimeout(() => process.exit(exitCode), PROCESS_TIMEOUT_MS);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      clearTimeout(forceExit);
    }
    process.exit(exitCode);
  };

  const httpHandle = createHttpApp(registry, {
    idleTimeoutMs,
    onIdle: shutdown,
    onShutdown: shutdown,
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
    })
    .catch((err) => {
      process.stderr.write(
        `[tool-server] Failed to start: ${err instanceof Error ? err.message : err}\n`
      );
      process.exit(1);
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
