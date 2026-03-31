import { attachRegistryLogger } from "@argent/registry";
import { createHttpApp } from "./http";
import { createRegistry } from "./utils/setup-registry";
import { validateStoredToken } from "./utils/license";
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from "./utils/idle-timer";

// ── Config ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const idleMinutes = parseInt(
  process.env.ARGENT_IDLE_TIMEOUT_MINUTES ?? String(DEFAULT_IDLE_TIMEOUT_MINUTES),
  10,
);
const idleTimeoutMs = idleMinutes > 0 ? idleMinutes * 60_000 : 0;

// ── Bootstrap ───────────────────────────────────────────────────────

const registry = createRegistry();
attachRegistryLogger(registry);

// `shutdown` captures `httpHandle` and `server` by closure; safe because it is
// only invoked asynchronously after both are initialized.
const shutdown = async () => {
  httpHandle.dispose();
  await registry.dispose();
  server.close();
  process.exit(0);
};

const httpHandle = createHttpApp(registry, {
  idleTimeoutMs,
  onIdle: shutdown,
  onShutdown: shutdown,
});

const server = httpHandle.app.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : PORT;
  process.stdout.write(`Tools server listening on http://127.0.0.1:${boundPort}\n`);
  console.log(`  GET  http://127.0.0.1:${boundPort}/tools`);
  console.log(`  POST http://127.0.0.1:${boundPort}/tools/:name`);
  if (idleTimeoutMs > 0) {
    console.log(`  Idle timeout: ${idleMinutes}min`);
  }
});

validateStoredToken().then((valid) => {
  if (valid) {
    console.log("  License token valid.");
  } else {
    console.log(
      "  No valid license found. Tools will prompt for activation on first use."
    );
  }
}).catch((err) => {
  console.error("  License validation error:", err);
});

// ── Lifecycle ───────────────────────────────────────────────────────

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
