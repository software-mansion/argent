import { attachRegistryLogger } from "@argent/registry";
import { createHttpApp } from "./http";
import { createRegistry } from "./utils/setup-registry";
import { startSimulatorWatcher } from "./utils/simulator-watcher";
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from "./utils/idle-timer";
import { startUpdateChecker } from "./utils/update-checker";

// The CLI package requires registry to read the tool list.
export { createRegistry };

export function start(): void {
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
  const shutdown = async () => {
    updateChecker.dispose();
    stopWatcher();
    httpHandle.dispose();
    await registry.dispose();
    server?.close();
    process.exit(0);
  };

  const httpHandle = createHttpApp(registry, {
    idleTimeoutMs,
    onIdle: shutdown,
    onShutdown: shutdown,
  });

  // Block advertising readiness until the first watcher poll completes — this
  // guarantees DYLD_INSERT_LIBRARIES is set in launchd for all currently-booted
  // simulators before any agent tool call (e.g. launch-app) can arrive.
  watcherReady.then(() => {
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
  });

  // ── Lifecycle ─────────────────────────────────────────────────────
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // When stdout is piped to a parent that stops reading (e.g. the MCP launcher
  // after it captures the startup line), writes via console.log emit EPIPE.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
  process.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}

export function getAvailableTools(): Array<{
  id: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}> {
  const registry = createRegistry();
  return registry.getAllTools().map((id) => {
    const def = registry.getTool(id)!;
    return { id: def.id, description: def.description, inputSchema: def.inputSchema };
  });
}

function printUsage(stream: NodeJS.WriteStream): void {
  stream.write(
    "Usage: tool-server <command>\n\n" +
      "Commands:\n" +
      "  start                        Start the tool server\n" +
      "  -t, --get-available-tools    Print available tools as JSON and exit\n"
  );
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "start") {
    start();
  } else if (cmd === "-t" || cmd === "--get-available-tools") {
    process.stdout.write(JSON.stringify(getAvailableTools(), null, 2) + "\n");
    process.exit(0);
  } else if (cmd === "-h" || cmd === "--help") {
    printUsage(process.stdout);
    process.exit(0);
  } else {
    if (cmd) process.stderr.write(`Unknown command: ${cmd}\n\n`);
    printUsage(process.stderr);
    process.exit(1);
  }
}
