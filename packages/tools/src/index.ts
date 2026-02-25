import { createHttpApp } from "./http";
import { registry } from "./registry";
import { listSimulatorsTool } from "./tools/list-simulators";
import { bootSimulatorTool } from "./tools/boot-simulator";
import { simulatorServerTool } from "./tools/simulator-server";

registry.register(listSimulatorsTool);
registry.register(bootSimulatorTool);
registry.register(simulatorServerTool);

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const app = createHttpApp();

app.listen(PORT, () => {
  console.log(`Tools server listening on http://localhost:${PORT}`);
  console.log(`  GET  http://localhost:${PORT}/tools`);
  console.log(`  POST http://localhost:${PORT}/tools/:name`);
});
