import {attachRegistryLogger} from "@radon-lite/registry";
import { createHttpApp } from "./http";
import { createRegistry } from "./setup-registry";

const registry = createRegistry();
attachRegistryLogger(registry);
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const app = createHttpApp(registry);

const server = app.listen(PORT, () => {
  console.log(`Tools server listening on http://localhost:${PORT}`);
  console.log(`  GET  http://localhost:${PORT}/tools`);
  console.log(`  POST http://localhost:${PORT}/tools/:name`);
});

const shutdown = async () => {
  await registry.dispose();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
