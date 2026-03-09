import { attachRegistryLogger } from "@radon-lite/registry";
import { createHttpApp } from "./http";
import { createRegistry } from "./utils/setup-registry";
import { validateStoredToken } from "./utils/license";

const registry = createRegistry();
attachRegistryLogger(registry);
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const app = createHttpApp(registry);

const server = app.listen(PORT, () => {
  console.log(`Tools server listening on http://localhost:${PORT}`);
  console.log(`  GET  http://localhost:${PORT}/tools`);
  console.log(`  POST http://localhost:${PORT}/tools/:name`);
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
});

const shutdown = async () => {
  await registry.dispose();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
