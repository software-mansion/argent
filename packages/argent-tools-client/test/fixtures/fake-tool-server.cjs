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
 *
 *   FAKE_IGNORE_SIGTERM=1    install no-op SIGTERM/SIGINT handlers so kill
 *                            has to escalate to SIGKILL
 */

const http = require("node:http");

const mode = process.env.FAKE_MODE || "ready";

if (mode === "exit-immediate") {
  process.exit(7);
}

const port = parseInt(process.env.ARGENT_PORT || "0", 10);
const host = process.env.ARGENT_HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  if (req.url === "/tools") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
    return;
  }
  res.writeHead(404);
  res.end();
});

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
