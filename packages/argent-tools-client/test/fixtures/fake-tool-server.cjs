#!/usr/bin/env node
/**
 * Test fixture: emulates the tool-server's startup protocol enough to drive
 * launcher.spawnToolsServer / killToolServer / isToolsServerHealthy without
 * shipping the real bundled server (which depends on simulator-server, native
 * dylibs, and platform-specific runtime probes).
 *
 * Behavior is controlled via env vars so individual tests can pick a mode:
 *
 *   FAKE_MODE=ready          (default) bind on $ARGENT_PORT/$ARGENT_HOST,
 *                            print the magic ready banner, serve GET /tools
 *   FAKE_MODE=exit-immediate exit with code 7 before printing anything
 *   FAKE_MODE=no-ready       bind silently — never print the ready line
 *                            (used to drive the spawn-timeout path)
 *   FAKE_MODE=unhealthy      bind and print the ready banner (so spawn resolves)
 *                            but answer GET /tools with 500 — emulates a wedged
 *                            server that is alive but fails its health check,
 *                            so ensureToolsServer must replace (and not orphan) it
 *
 *   FAKE_IGNORE_SIGTERM=1    install no-op SIGTERM/SIGINT handlers so kill
 *                            has to escalate to SIGKILL
 *   FAKE_TTL_MS=<n>          self-exit after <n> ms — a safety net so a test
 *                            that (pre-fix) leaks a duplicate server never
 *                            strands a long-lived orphan on the CI host
 *   FAKE_PIDFILE=<path>      write this process's pid to <path> on startup, so a
 *                            test that drives the readiness-timeout path (where
 *                            spawnToolsServer rejects without returning a pid)
 *                            can still find the child and assert it was reaped
 */

const fs = require("node:fs");
const http = require("node:http");

const mode = process.env.FAKE_MODE || "ready";

// Written first thing so even exit-immediate / no-ready modes expose their pid.
if (process.env.FAKE_PIDFILE) {
  try {
    fs.writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
  } catch {
    /* best-effort */
  }
}

if (mode === "exit-immediate") {
  process.exit(7);
}

const port = parseInt(process.env.ARGENT_PORT || "0", 10);
const host = process.env.ARGENT_HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  if (req.url === "/tools") {
    if (mode === "unhealthy") {
      // Alive but failing health: ensureToolsServer should treat this as
      // "no usable server", terminate it, and spawn a replacement.
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"unhealthy"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
    return;
  }
  res.writeHead(404);
  res.end();
});

const ttlMs = parseInt(process.env.FAKE_TTL_MS || "0", 10);
if (ttlMs > 0) {
  setTimeout(() => process.exit(0), ttlMs).unref();
}

server.listen(port, host, () => {
  if (mode === "no-ready") {
    // Bound but stay silent — useful for testing the readiness timeout path.
    return;
  }
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  process.stdout.write(`Tools server listening on http://${host}:${boundPort}\n`);
});

if (process.env.FAKE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    /* swallow — forces killToolServer to escalate */
  });
  process.on("SIGINT", () => {
    /* swallow */
  });
} else {
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
