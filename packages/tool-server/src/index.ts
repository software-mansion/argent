import { attachRegistryLogger } from "@radon-lite/registry";
import { createHttpApp } from "./http";
import { createRegistry } from "./utils/setup-registry";
import { validateStoredToken } from "./utils/license";

const registry = createRegistry();
attachRegistryLogger(registry);
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const app = createHttpApp(registry);

const server = app.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : PORT;
  process.stdout.write(`Tools server listening on http://127.0.0.1:${boundPort}\n`);
  console.log(`  GET  http://127.0.0.1:${boundPort}/tools`);
  console.log(`  POST http://127.0.0.1:${boundPort}/tools/:name`);
});

// Validate stored token on startup
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

const shutdown = async () => {
  await registry.dispose();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// When stdout is piped to a parent that stops reading (e.g. the MCP launcher after
// it captures the startup line), writes via console.log emit EPIPE. Ignore those.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EPIPE") throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EPIPE") throw err;
});
