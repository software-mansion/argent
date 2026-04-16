import { attachRegistryLogger } from "@argent/registry";
import { createHttpApp } from "./http";
import { createRegistry } from "./utils/setup-registry";
import { startSimulatorWatcher } from "./utils/simulator-watcher";
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from "./utils/idle-timer";
import { startUpdateChecker } from "./utils/update-checker";

export function start(): void {
  // ── Global error handlers ─────────────────────────────────────────
  // The tool server should exit on uncaught errors (state may be corrupted),
  // but attempt graceful cleanup first so child processes are not orphaned.
  let shuttingDown = false;
  let shutdown: ((exitCode?: number) => Promise<void>) | null = null;

  function crashShutdown(label: string, detail: string): void {
    process.stderr.write(`[tool-server] ${label}: ${detail}\n`);
    if (shuttingDown) return; // avoid re-entrant shutdown
    shuttingDown = true;
    // 5s grace period for registry.dispose() to clean up child processes
    const forceExit = setTimeout(() => process.exit(1), 5_000);
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
  const PORT = parseInt(process.env.PORT ?? "3001", 10);
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
      const forceExit = setTimeout(() => process.exit(exitCode), 5_000);
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
      server = httpHandle.app.listen(PORT, "127.0.0.1", () => {
        const addr = server!.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : PORT;
        process.stdout.write(`Tools server listening on http://127.0.0.1:${boundPort}\n`);
        process.stderr.write(`  GET  http://127.0.0.1:${boundPort}/tools\n`);
        process.stderr.write(`  POST http://127.0.0.1:${boundPort}/tools/:name\n`);
        if (idleTimeoutMs > 0) {
          process.stderr.write(`  Idle timeout: ${idleMinutes}min\n`);
        }
      });
    })
    .catch((err) => {
      process.stderr.write(
        `[tool-server] Failed to start: ${err instanceof Error ? err.message : err}\n`
      );
      process.exit(1);
    });

  // ── Lifecycle ─────────────────────────────────────────────────────
  process.on("SIGINT", () => (shutdown ? shutdown() : process.exit(0)));
  process.on("SIGTERM", () => (shutdown ? shutdown() : process.exit(0)));

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
